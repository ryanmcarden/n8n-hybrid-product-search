-- Hybrid Search Pipeline — Generic Product Schema
-- Production version runs against Microsoft SQL Server
-- Replace table/column names to match your catalog

-- Core product table
CREATE TABLE Products (
    ProductID     INT           NOT NULL PRIMARY KEY,
    ProdNo        NVARCHAR(50)  NOT NULL UNIQUE,   -- e.g. "ST640", "R112"
    Brand         NVARCHAR(100),
    Title         NVARCHAR(255),
    ShortDescription NVARCHAR(512),
    LongDescription  NVARCHAR(MAX),
    Category      NVARCHAR(255),                   -- e.g. "Headwear > Trucker Caps"
    AltTag        NVARCHAR(255),
    SizeScale     NVARCHAR(100),                   -- e.g. "S/M/L/XL"
    LargePic      NVARCHAR(512),                   -- image filename or path
    IsActive      BIT           NOT NULL DEFAULT 1
);

-- Pricing table (quantity-break pricing)
-- Price288 = price at 288 units (bulk), Price12 = price at 12 units (minimum)
CREATE TABLE ProductPrices (
    PriceID       INT   NOT NULL PRIMARY KEY,
    ProductID     INT   NOT NULL REFERENCES Products(ProductID),
    Price12       DECIMAL(10,2),    -- price at minimum quantity
    Price288      DECIMAL(10,2),    -- price at bulk quantity
    -- add intermediate breaks as needed
);

-- Product attributes (colors, sizes per color)
CREATE TABLE ProductAttributes (
    AttributeID   INT           NOT NULL PRIMARY KEY,
    ProductID     INT           NOT NULL REFERENCES Products(ProductID),
    Color         NVARCHAR(100),
    Size          NVARCHAR(50),
    InStock       BIT           NOT NULL DEFAULT 1
);

-- Active sales / discount records
CREATE TABLE Specials (
    SpecialID        INT           NOT NULL PRIMARY KEY,
    SpecialType      NVARCHAR(50),                   -- e.g. "category", "product"
    SpecialItem      NVARCHAR(255),                  -- category name or ProdNo
    SpecialDiscount  DECIMAL(5,4),                   -- e.g. 0.10 = 10% off
    SpecialStartDate DATE          NOT NULL,
    SpecialEndDate   DATE          NOT NULL
);

-- Order history (used for bestseller ranking)
CREATE TABLE Orders (
    OrderID     INT      NOT NULL PRIMARY KEY,
    OrderDate   DATETIME NOT NULL
);

CREATE TABLE OrderDetails (
    DetailID    INT            NOT NULL PRIMARY KEY,
    OrderID     INT            NOT NULL REFERENCES Orders(OrderID),
    ProdNo      NVARCHAR(50)   NOT NULL,
    Quantity    INT,
    Total       DECIMAL(10,2)
);

-- Bestseller query (last 30 days, by revenue)
-- SELECT TOP 100 PERCENT
--     od.ProdNo,
--     SUM(od.Total) AS RevenueTotal
-- FROM Orders o
-- JOIN OrderDetails od ON o.OrderID = od.OrderID
-- WHERE o.OrderDate > GETDATE() - 30
-- GROUP BY od.ProdNo
-- ORDER BY RevenueTotal DESC;
