-- Sample retail schema for the Quest Data Modeler reverse-engineering demo.
-- Targets Microsoft Fabric / Data Warehouse (T-SQL) — uses BIT instead of
-- BOOLEAN, NVARCHAR(MAX) instead of TEXT, DATETIME2 instead of TIMESTAMP,
-- and 1/0 literals instead of TRUE/FALSE so the modeler's parser accepts it.

CREATE TABLE Customer (
    customer_id    BIGINT         NOT NULL PRIMARY KEY,
    email          NVARCHAR(255)  NOT NULL UNIQUE,
    full_name      NVARCHAR(120)  NOT NULL,
    phone          NVARCHAR(32),
    created_at     DATETIME2      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active      BIT            NOT NULL DEFAULT 1
);

CREATE TABLE Product (
    product_id     BIGINT         NOT NULL PRIMARY KEY,
    sku            NVARCHAR(40)   NOT NULL UNIQUE,
    name           NVARCHAR(200)  NOT NULL,
    description    NVARCHAR(MAX),
    unit_price     DECIMAL(12,2)  NOT NULL,
    inventory_qty  INT            NOT NULL DEFAULT 0
);

CREATE TABLE Orders (
    order_id       BIGINT         NOT NULL PRIMARY KEY,
    customer_id    BIGINT         NOT NULL,
    order_date     DATE           NOT NULL,
    status         NVARCHAR(20)   NOT NULL,
    total_amount   DECIMAL(14,2)  NOT NULL,
    CONSTRAINT fk_orders_customer
        FOREIGN KEY (customer_id) REFERENCES Customer(customer_id)
);

CREATE TABLE OrderLine (
    order_line_id  BIGINT         NOT NULL PRIMARY KEY,
    order_id       BIGINT         NOT NULL,
    product_id     BIGINT         NOT NULL,
    quantity       INT            NOT NULL,
    line_total     DECIMAL(14,2)  NOT NULL,
    CONSTRAINT fk_orderline_order
        FOREIGN KEY (order_id) REFERENCES Orders(order_id),
    CONSTRAINT fk_orderline_product
        FOREIGN KEY (product_id) REFERENCES Product(product_id)
);

CREATE INDEX idx_orders_customer   ON Orders(customer_id);
CREATE INDEX idx_orderline_order   ON OrderLine(order_id);
CREATE INDEX idx_orderline_product ON OrderLine(product_id);
