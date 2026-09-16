import { useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * Free-text field with a real dropdown of suggestions.
 *
 * Replaces `<input list="...">`. A native `<datalist>` filters its popup by what
 * is already in the field, so a row holding "Technology" offered exactly one
 * suggestion — "Technology" — which made it useless for the main thing you want
 * a category dropdown for: changing a category to a different one. Only an empty
 * field (the add row) ever showed the full list, which is why the dropdown
 * looked like it worked there and nowhere else.
 *
 * So: the caret shows every option regardless of the current value, and typing
 * narrows the list. The value stays free text — a category does not have to come
 * from the list — so this is a combobox, not a select.
 */
export interface CategoryInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Suggestions, in the order they should be offered. */
  options: string[];
  placeholder?: string;
  /** Accessible name. Use when there is no visible <label> wrapping this. */
  ariaLabel?: string;
  /** Merged over the field styling, e.g. an error border. */
  style?: React.CSSProperties;
  /**
   * Show the value but refuse edits: no typing, no caret, no dropdown.
   *
   * `readOnly` rather than `disabled` so the value stays selectable, copyable
   * and reachable by keyboard — it is information, not a dead control.
   */
  readOnly?: boolean;
}

export function CategoryInput({
  value, onChange, options, placeholder, ariaLabel, style, readOnly = false,
}: CategoryInputProps) {
  const [wantOpen, setWantOpen] = useState(false);
  /**
   * A read-only field never shows the list, derived rather than synchronised:
   * becoming read-only while the list is showing must close it, and doing that in
   * an effect would leave a frame where an unusable dropdown is on screen.
   */
  const open = wantOpen && !readOnly;
  /**
   * Whether the list is narrowed to `value`.
   *
   * False when opened with the caret — that is a request to see everything, not
   * to see what matches what is already typed. True once the user types.
   */
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(-1);

  const wrap = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const listId = `cat-list-${useId()}`;

  const shown = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!filtering || !q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, value, filtering]);

  // Close on a click anywhere else. Pointerdown rather than click so the list is
  // gone before the next control reacts.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setWantOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const openAll = () => {
    if (readOnly) return;
    setFiltering(false);
    setWantOpen(true);
    // Start on the current value if it is one of the options, so Up/Down moves
    // from where you are rather than from the top of a 51-entry list.
    setActive(options.findIndex((o) => o.toLowerCase() === value.trim().toLowerCase()));
  };

  const commit = (next: string) => {
    onChange(next);
    setWantOpen(false);
    setFiltering(false);
    input.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (readOnly) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { openAll(); return; }
      setActive((i) => (shown.length === 0 ? -1 : (i + 1) % shown.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openAll(); return; }
      setActive((i) => (shown.length === 0 ? -1 : (i <= 0 ? shown.length : i) - 1));
      return;
    }
    if (e.key === 'Enter' && open && active >= 0 && active < shown.length) {
      e.preventDefault();
      commit(shown[active]);
      return;
    }
    if (e.key === 'Escape' && open) {
      // Stop here: this key would otherwise reach the row and cancel a drag.
      e.preventDefault();
      e.stopPropagation();
      setWantOpen(false);
      return;
    }
    if (e.key === 'Tab') setWantOpen(false);
  };

  return (
    <div ref={wrap} style={s.wrap}>
      <input
        ref={input}
        // Only a combobox when it can actually be used as one.
        role={readOnly ? undefined : 'combobox'}
        aria-expanded={readOnly ? undefined : open}
        aria-controls={readOnly ? undefined : listId}
        aria-autocomplete={readOnly ? undefined : 'list'}
        aria-activedescendant={!readOnly && open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        readOnly={readOnly}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          if (readOnly) return;
          onChange(e.target.value);
          setFiltering(true);
          setWantOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        style={{
          ...s.input,
          // No caret to leave room for when there is no dropdown.
          ...(readOnly ? s.inputReadOnly : {}),
          ...style,
        }}
      />
      {!readOnly && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => (open ? setWantOpen(false) : openAll())}
          style={s.caret}
          title="Show categories"
        >
          ▾
        </button>
      )}

      {open && shown.length > 0 && (
        <ul id={listId} role="listbox" style={s.list}>
          {shown.map((o, i) => (
            <li
              key={o}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.toLowerCase() === value.trim().toLowerCase()}
              // Mousedown, not click: the input's blur would otherwise close the
              // list before the click landed.
              onMouseDown={(e) => { e.preventDefault(); commit(o); }}
              onMouseEnter={() => setActive(i)}
              style={{
                ...s.option,
                ...(i === active ? s.optionActive : {}),
                ...(o.toLowerCase() === value.trim().toLowerCase() ? s.optionCurrent : {}),
              }}
            >
              {o}
            </li>
          ))}
        </ul>
      )}
      {open && shown.length === 0 && (
        <ul id={listId} role="listbox" style={s.list}>
          <li role="option" aria-selected={false} aria-disabled="true" style={s.empty}>
            No match — “{value.trim()}” will be used as typed
          </li>
        </ul>
      )}
    </div>
  );
}

const s = {
  wrap: { position: 'relative', display: 'flex', minWidth: 0 } as React.CSSProperties,
  input: {
    // Room for the caret so a long category doesn't run underneath it.
    padding: '9px 26px 9px 10px', minHeight: 40, width: '100%', minWidth: 0,
    fontSize: 14, fontFamily: 'inherit', color: 'inherit', background: 'transparent',
    border: '1px solid rgba(128,128,128,0.4)', borderRadius: 6,
  } as React.CSSProperties,
  /** Reads as "shown, not editable": greyed fill, and no gap kept for a caret. */
  inputReadOnly: {
    paddingRight: 10,
    background: 'rgba(128,128,128,0.10)',
    color: '#666',
    cursor: 'default',
  } as React.CSSProperties,
  caret: {
    position: 'absolute', right: 1, top: 1, bottom: 1, width: 22,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, border: 'none', borderRadius: '0 5px 5px 0',
    background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11,
    opacity: 0.55, cursor: 'pointer',
  } as React.CSSProperties,
  list: {
    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
    margin: '2px 0 0', padding: 4, listStyle: 'none',
    maxHeight: 260, overflowY: 'auto',
    background: '#fff', color: '#222',
    border: '1px solid rgba(128,128,128,0.4)', borderRadius: 8,
    boxShadow: '0 6px 20px rgba(0,0,0,0.16)',
  } as React.CSSProperties,
  option: {
    padding: '8px 10px', minHeight: 36, display: 'flex', alignItems: 'center',
    fontSize: 13, borderRadius: 5, cursor: 'pointer',
  } as React.CSSProperties,
  optionActive: { background: 'rgba(52,152,219,0.16)' } as React.CSSProperties,
  optionCurrent: { fontWeight: 650 } as React.CSSProperties,
  empty: {
    padding: '8px 10px', fontSize: 12, color: '#888', cursor: 'default',
  } as React.CSSProperties,
};
