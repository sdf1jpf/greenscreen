// The point of sale's data, behind one interface: D1 in the Worker, memory
// in the tests. An in-store box would put a local SQLite file here.

export interface Product { sku: string; desc: string; price: number } // price in cents
export interface Line { sku: string; desc: string; qty: number; price: number }
export type Tender = "CASH" | "CARD";

export interface Sale {
	id: number;
	token: string; // made when the sale starts: recording the same token again returns the first sale
	at: string; // RFC 3339, UTC
	cashier: string;
	lines: Line[];
	subtotal: number;
	tax: number;
	total: number;
	tender: Tender;
	paid: number;
	change: number;
}

export type NewSale = Omit<Sale, "id" | "at">;

export interface DaySummary {
	count: number;
	subtotal: number;
	tax: number;
	total: number;
	byTender: Record<Tender, { count: number; total: number }>;
}

export interface Store {
	product(sku: string): Promise<Product | undefined>;
	products(): Promise<Product[]>;
	recordSale(s: NewSale): Promise<Sale>; // once per token
	sale(id: number): Promise<Sale | undefined>;
	sales(limit: number): Promise<Sale[]>; // newest first, without lines
	summary(from: string, to: string): Promise<DaySummary>; // sales at or after from and before to
}

function emptySummary(): DaySummary {
	return { count: 0, subtotal: 0, tax: 0, total: 0, byTender: { CASH: { count: 0, total: 0 }, CARD: { count: 0, total: 0 } } };
}

export class D1Store implements Store {
	constructor(private db: D1Database) {}

	async product(sku: string) {
		return (await this.db.prepare("SELECT sku, descr AS \"desc\", price FROM products WHERE sku = ?").bind(sku).first<Product>()) ?? undefined;
	}

	async products() {
		return (await this.db.prepare("SELECT sku, descr AS \"desc\", price FROM products ORDER BY sku").all<Product>()).results;
	}

	async recordSale(s: NewSale) {
		const at = new Date().toISOString();
		const row = await this.db.prepare(
			"INSERT INTO sales (token, at, cashier, subtotal, tax, total, tender, paid, change) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
			"ON CONFLICT (token) DO NOTHING RETURNING id",
		).bind(s.token, at, s.cashier, s.subtotal, s.tax, s.total, s.tender, s.paid, s.change).first<{ id: number }>();
		if (!row) {
			const first = await this.db.prepare("SELECT id FROM sales WHERE token = ?").bind(s.token).first<{ id: number }>();
			return (await this.sale(first!.id))!;
		}
		const id = row.id;
		await this.db.batch(s.lines.map((l, i) =>
			this.db.prepare("INSERT INTO sale_lines (sale, line, sku, descr, qty, price) VALUES (?, ?, ?, ?, ?, ?)")
				.bind(id, i + 1, l.sku, l.desc, l.qty, l.price)));
		return { ...s, id, at };
	}

	async sale(id: number) {
		const s = await this.db.prepare("SELECT * FROM sales WHERE id = ?").bind(id).first<Omit<Sale, "lines">>();
		if (!s) return undefined;
		const lines = (await this.db.prepare("SELECT sku, descr AS \"desc\", qty, price FROM sale_lines WHERE sale = ? ORDER BY line")
			.bind(id).all<Line>()).results;
		return { ...s, lines };
	}

	async sales(limit: number) {
		const rows = (await this.db.prepare("SELECT * FROM sales ORDER BY id DESC LIMIT ?").bind(limit).all<Omit<Sale, "lines">>()).results;
		return rows.map((r) => ({ ...r, lines: [] }));
	}

	async summary(from: string, to: string) {
		const rows = (await this.db.prepare(
			"SELECT tender, COUNT(*) AS n, SUM(subtotal) AS sub, SUM(tax) AS tax, SUM(total) AS total FROM sales WHERE at >= ? AND at < ? GROUP BY tender",
		).bind(from, to).all<{ tender: Tender; n: number; sub: number; tax: number; total: number }>()).results;
		const out = emptySummary();
		for (const r of rows) {
			out.count += r.n;
			out.subtotal += r.sub;
			out.tax += r.tax;
			out.total += r.total;
			out.byTender[r.tender] = { count: r.n, total: r.total };
		}
		return out;
	}
}

export class MemoryStore implements Store {
	private list: Sale[] = [];
	constructor(private catalog: Product[]) {}

	async product(sku: string) {
		return this.catalog.find((p) => p.sku === sku);
	}

	async products() {
		return [...this.catalog].sort((a, b) => a.sku.localeCompare(b.sku));
	}

	async recordSale(s: NewSale) {
		const again = this.list.find((x) => x.token === s.token);
		if (again) return again;
		const sale = { ...s, id: this.list.length + 1, at: new Date().toISOString() };
		this.list.push(sale);
		return sale;
	}

	async sale(id: number) {
		return this.list.find((s) => s.id === id);
	}

	async sales(limit: number) {
		return [...this.list].reverse().slice(0, limit);
	}

	async summary(from: string, to: string) {
		const out = emptySummary();
		for (const s of this.list.filter((s) => s.at >= from && s.at < to)) {
			out.count++;
			out.subtotal += s.subtotal;
			out.tax += s.tax;
			out.total += s.total;
			out.byTender[s.tender].count++;
			out.byTender[s.tender].total += s.total;
		}
		return out;
	}
}
