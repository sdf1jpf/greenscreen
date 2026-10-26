// Field help: PF1 with the cursor in an input field explains that field,
// as CICS and ISPF applications do. A field with a fixed set of valid
// values lists them under the help, as ISPF prompts do: S beside one puts
// it in the field.

import type { Ctx } from "./screen";
import type { PanelState } from "./program";

export interface Value {
	code: string;
	desc: string;
}

export interface FieldHelp<E = unknown> {
	title: string;
	lines: string[];
	values?: Value[] | ((ctx: Ctx<E>, s: PanelState) => Value[] | Promise<Value[]>);
}

// FieldHelpLookup returns the help for a field on the panel s shows, if any.
export type FieldHelpLookup<E = unknown> = (s: PanelState, field: string) => FieldHelp<E> | undefined;

// values builds a list of valid values from code, description pairs.
export const values = (...pairs: [string, string][]): Value[] => pairs.map(([code, desc]) => ({ code, desc }));

// helpTable looks help up by panel and field name first ("browse.status"),
// then by field name alone. A field name is cut at its first colon, so
// that numbered fields share an entry ("qty:3" uses "qty"), and selection
// fields ("sel:000101", "sel0") share "sel".
export function helpTable<E = unknown>(table: Record<string, FieldHelp<E>>): FieldHelpLookup<E> {
	return (s, field) => {
		if (!field) return undefined;
		const name = field.startsWith("sel") ? "sel" : field.split(":")[0];
		return table[`${s.p}.${name}`] ?? table[name];
	};
}

// fieldValues returns the valid values for a field, or none.
export async function fieldValues<E>(ctx: Ctx<E>, fh: FieldHelp<E>, s: PanelState): Promise<Value[]> {
	if (!fh.values) return [];
	return Array.isArray(fh.values) ? fh.values : fh.values(ctx, s);
}
