CREATE TABLE `order_risk` (
	`order_id` integer PRIMARY KEY NOT NULL,
	`score` integer NOT NULL,
	`level` text NOT NULL,
	`headline` text NOT NULL,
	`factors` text NOT NULL,
	`computed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `order_risk_level_idx` ON `order_risk` (`level`);