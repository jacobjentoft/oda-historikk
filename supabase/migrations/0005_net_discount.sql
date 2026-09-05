-- fees_delta assumed gross_amount > sum(lines), i.e. that Oda ADDS fees.
-- The first five orders disproved that: the delta is negative on every one,
-- between -20.83 and -105.91. Line totals are internally exact
-- (unit_price * quantity = line_total on all 152 lines), so this is real:
-- line prices are PRE-discount, and gross_amount is what was actually charged.
--
-- Renamed and flipped so a positive number means "paid less than list".
-- It nets discounts against any delivery fee; the two cannot be separated
-- from this data, so treat it as net, not as gross campaign savings.

alter table orders drop column if exists fees_delta;

alter table orders add column net_discount numeric(10,2)
  generated always as (line_total - gross_amount) stored;
