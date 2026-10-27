// The on-screen keyboard of a phone or tablet types into a real text box,
// not into the page, and often sends no usable key codes ("Unidentified").
// The terminal keeps a hidden box holding one placeholder character and
// reads what changed after each input: characters added after it were
// typed, and the placeholder gone means Backspace.

export const PLACEHOLDER = " ";

// typed reads the box's value after an input event: the characters typed
// and how many Backspaces were pressed. Line breaks come back as "\n".
/** @param {string} value */
export function typed(value) {
	if (value === PLACEHOLDER) return { text: "", backspaces: 0 };
	if (!value.startsWith(PLACEHOLDER)) {
		// The placeholder was deleted, or typed over by a selection.
		return { text: value.replace(/\r\n?/g, "\n"), backspaces: value.length === 0 ? 1 : 0 };
	}
	return { text: value.slice(PLACEHOLDER.length).replace(/\r\n?/g, "\n"), backspaces: 0 };
}
