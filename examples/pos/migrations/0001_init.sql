-- The point-of-sale example: a price list and the sales rung up against it.
-- Money is in cents.

CREATE TABLE products (
	sku   TEXT PRIMARY KEY,
	descr TEXT NOT NULL,
	price INTEGER NOT NULL
);

CREATE TABLE sales (
	id       INTEGER PRIMARY KEY AUTOINCREMENT,
	token    TEXT NOT NULL UNIQUE,      -- set when the sale starts, so a retried tender is written once
	at       TEXT NOT NULL,          -- RFC 3339, UTC
	cashier  TEXT NOT NULL,
	subtotal INTEGER NOT NULL,
	tax      INTEGER NOT NULL,
	total    INTEGER NOT NULL,
	tender   TEXT NOT NULL CHECK (tender IN ('CASH', 'CARD')),
	paid     INTEGER NOT NULL,
	change   INTEGER NOT NULL
);
CREATE INDEX sales_at ON sales (at);

CREATE TABLE sale_lines (
	sale  INTEGER NOT NULL REFERENCES sales (id),
	line  INTEGER NOT NULL,
	sku   TEXT NOT NULL,
	descr TEXT NOT NULL,
	qty   INTEGER NOT NULL,
	price INTEGER NOT NULL,
	PRIMARY KEY (sale, line)
);

INSERT INTO products (sku, descr, price) VALUES
	('1001', 'COFFEE, LARGE', 325),
	('1002', 'COFFEE, SMALL', 250),
	('1003', 'ESPRESSO', 300),
	('2001', 'BAGEL, PLAIN', 195),
	('2002', 'BAGEL, EVERYTHING', 225),
	('2003', 'CREAM CHEESE', 125),
	('3001', 'MUFFIN, BLUEBERRY', 350),
	('3002', 'SCONE, CURRANT', 375),
	('4001', 'ORANGE JUICE', 425),
	('4002', 'BOTTLED WATER', 175),
	('5001', 'NEWSPAPER', 300),
	('5002', 'GIFT CARD, $25', 2500);
