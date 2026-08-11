"use client";

import { useEffect, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { PostgreSQL, sql } from "@codemirror/lang-sql";

/**
 * CodeMirror 6 SQL editor (Postgres dialect) — the console's query surface.
 * Controlled-ish: `value` seeds the document and later external changes
 * (loading a saved snippet) are dispatched in; user typing flows out through
 * `onChange`. Mod-Enter (⌘/Ctrl+Enter) fires `onRun` — the Studio keybinding.
 *
 * Visual theming lives in globals.css under `.sqled` (design tokens), not a
 * JS theme, so light/dark follow the app's data-theme axis for free. Syntax
 * colors included: `classHighlighter` tags tokens with stable `.tok-*`
 * classes (supplanting basicSetup's fallback defaultHighlightStyle, whose
 * fixed light-mode hex was illegible on the dark chrome), and globals.css
 * binds the palette per theme.
 */
export function SqlEditor({
  value,
  onChange,
  onRun,
  ariaLabel = "SQL editor",
}: {
  value: string;
  onChange: (doc: string) => void;
  onRun: () => void;
  ariaLabel?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Refs so the CodeMirror extensions (created once) always see fresh handlers.
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  useEffect(() => {
    if (!host.current) return;

    const editor = new EditorView({
      doc: value,
      parent: host.current,
      extensions: [
        // The run keybinding must beat basicSetup's Enter handling.
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                onRunRef.current();
                return true;
              },
            },
          ]),
        ),
        basicSetup,
        // Class-based highlighting (`.tok-*`) so the palette lives in
        // globals.css and follows data-theme; being a non-fallback highlighter
        // it disables basicSetup's built-in defaultHighlightStyle.
        syntaxHighlighting(classHighlighter),
        sql({ dialect: PostgreSQL }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    view.current = editor;

    return () => {
      editor.destroy();
      view.current = null;
    };
    // Mount once — `value` afterwards syncs through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (snippet loads) replace the document; user typing
  // round-trips through onChange so this is a no-op for self-caused updates.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (value !== current) {
      editor.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={host} className="sqled" role="textbox" aria-label={ariaLabel} />;
}

export default SqlEditor;
