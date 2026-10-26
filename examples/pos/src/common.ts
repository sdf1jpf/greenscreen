// What the panels share: the Worker's bindings, the store, money and the
// sale arithmetic.

import type { AccessEnv, Ctx, MenuState, PanelState } from "@greenscreen/worker";
import { D1Store, type Line, type Store } from "./store";

export interface Env extends AccessEnv {
	DB: D1Database;
	STATE_KEY?: string; // signs the commarea, so a sale's lines and prices can be trusted
	STORE?: Store; // tests put a MemoryStore here
}

export type PosCtx = Ctx<Env>;

export function store(ctx: PosCtx): Store {
	return ctx.env.STORE ?? new D1Store(ctx.env.DB);
}

export const TAX_RATE = 0.0825;

// The panels' states.
export interface SaleState extends PanelState { p: "sale"; back: MenuState; token: string; lines: Line[]; errField?: string }

// newSale starts an empty sale with a fresh token.
export function newSale(back: MenuState, msg?: string): SaleState {
	return { p: "sale", back, token: crypto.randomUUID(), lines: [], ...(msg ? { msg } : {}) };
}
export interface TenderState extends PanelState { p: "tender"; back: SaleState; errField?: string }
export interface ReceiptState extends PanelState { p: "receipt"; back: PanelState; id: number; next?: boolean } // next: Enter starts a new sale
export interface ReceiptsState extends PanelState { p: "receipts"; back: MenuState; top?: number; ids?: number[]; errSel?: string }
export interface PricesState extends PanelState { p: "prices"; back: MenuState; top?: number }
export interface EodState extends PanelState { p: "eod"; back: MenuState }

// dollars formats cents: 1234 -> "12.34", -5 -> "-0.05".
export function dollars(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	const c = Math.abs(Math.round(cents));
	return `${sign}${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

// cents reads an amount typed as dollars ("12", "12.5", "12.34"), or
// returns undefined.
export function cents(s: string): number | undefined {
	const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(s.trim());
	if (!m) return undefined;
	return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

export function totals(lines: Line[]): { subtotal: number; tax: number; total: number } {
	const subtotal = lines.reduce((n, l) => n + l.qty * l.price, 0);
	const tax = Math.round(subtotal * TAX_RATE);
	return { subtotal, tax, total: subtotal + tax };
}

// listRows is how many list rows fit between a list starting on row
// first and the message line.
export function listRows(ctx: PosCtx, first: number): number {
	return Math.max(ctx.rows - 3 - first + 1, 1);
}
