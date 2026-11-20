/**
 * The preset dialog: field collector, server-built preview, fill-in.
 *
 * WHY a generic dialog: every preset is "collect fields, ask the plane to
 * merge a fragment, review, fill the editor" — the only per-preset data is
 * the descriptor the API returns. WHY nothing is saved here: the preset
 * fills the existing editor, the admin reviews it, and the ordinary Save
 * config button performs the one write.
 *
 * WHY a build button instead of live preview: the WARP preset registers a
 * real device per build, so previews must be deliberate.
 */
import { useState } from "react";

import { buildNodePreset } from "../api";
import CopyButton from "./CopyButton";
import ErrorNote from "./ErrorNote";
import Field from "./Field";
import Icon from "./icons";
import Modal from "./Modal";
import { inputClass, primaryButton, secondaryButton, selectClass } from "./styles";
import type { PresetBuildOut, PresetOut } from "../types";

export default function PresetDialog({
  nodeId,
  preset,
  document,
  onClose,
  onFill,
}: {
  nodeId: string;
  preset: PresetOut;
  /** The editor's current document, or null for the base skeleton. */
  document: Record<string, unknown> | null;
  onClose: () => void;
  onFill: (json: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({
    ...preset.defaults,
  });
  const [preview, setPreview] = useState<PresetBuildOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const build = async () => {
    setBusy(true);
    setError(null);
    const result = await buildNodePreset(nodeId, preset.id, document, values);
    setBusy(false);
    if (result.error) {
      setPreview(null);
      setError(result.error);
      return;
    }
    setPreview(result.data);
  };

  return (
    <Modal
      title={preset.label}
      description={preset.summary}
      onClose={onClose}
      wide
      footer={
        <>
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => void build()}
          >
            {busy ? "Building…" : preview ? "Build again" : "Build preview"}
          </button>
          {preview && (
            <CopyButton
              text={JSON.stringify(preview.config, null, 2)}
              label="Copy JSON"
            />
          )}
          <button
            type="button"
            className={primaryButton}
            disabled={preview === null}
            onClick={() => {
              if (preview !== null) {
                onFill(JSON.stringify(preview.config, null, 2));
                onClose();
              }
            }}
          >
            Fill editor
          </button>
        </>
      }
    >
      <div className="cf-formrow">
        {preset.fields.map((field) => (
          <Field key={field.name} label={field.label} hint={field.hint}>
            {field.choices && field.choices.length > 0 ? (
              <select
                className={selectClass}
                value={values[field.name] ?? ""}
                onChange={(event) =>
                  setValues({ ...values, [field.name]: event.target.value })
                }
              >
                {field.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={inputClass}
                value={values[field.name] ?? ""}
                onChange={(event) =>
                  setValues({ ...values, [field.name]: event.target.value })
                }
              />
            )}
          </Field>
        ))}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {preview && (
        <>
          {preview.warnings.length > 0 && (
            <div className="cf-alert cf-alert--warn">
              <Icon name="alert-triangle" />
              <span>
                {preview.warnings.map((warning) => (
                  <span key={warning} className="cf-stack">
                    {warning}
                  </span>
                ))}
              </span>
            </div>
          )}
          <div className="cf-stack">
            <span className="cf-label">Preview</span>
            <pre className="cf-code">{JSON.stringify(preview.config, null, 2)}</pre>
          </div>
        </>
      )}
    </Modal>
  );
}
