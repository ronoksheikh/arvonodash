import { and, eq, sql, type AnyColumn } from "drizzle-orm";
import type { DB } from "../db";
import { callLogs, consignments, orders, payments } from "../db/schema";
import { businessDate, dayRange } from "./dispatch";
import { localTimeIso } from "./pickup";
import type { AppSettings } from "./settings";

const DAY = 86_400_000;
const n = (v: unknown) => Number(v ?? 0);

/**
 * Owner report for a range of Asia/Dhaka business dates: orders and calls, courier flow, money,
 * same-day dispatch against the cut-off, and where returns come from (districts and products).
 */
export async function ownerReport(db: DB, settings: AppSettings, offset: string, fromDate: string, toDate: string) {
  const range = dayRange(fromDate, offset, toDate);
  const inRange = (col: AnyColumn) => sql`${col} >= ${range.from} and ${col} < ${range.to}`;

  const cohort = await db
    .select({
      received: sql<number>`count(*)`,
      value: sql<number>`coalesce(sum(case when ${orders.cancelledAt} is null then ${orders.total} end), 0)`,
      cancelled: sql<number>`sum(case when ${orders.cancelledAt} is not null then 1 else 0 end)`,
      confirmed: sql<number>`sum(case when ${orders.callingStatus} = 'confirmed' or ${orders.courierStage} != 'unbooked' then 1 else 0 end)`,
      rejected: sql<number>`sum(case when ${orders.callingStatus} = 'rejected' then 1 else 0 end)`,
      pending: sql<number>`sum(case when ${orders.cancelledAt} is null and ${orders.courierStage} = 'unbooked' and ${orders.callingStatus} in ('not_called', 'no_answer', 'call_again') then 1 else 0 end)`,
      newCustomers: sql<number>`sum(case when not exists (select 1 from orders o2 where o2.phone = ${orders.phone} and o2.shop_created_at < ${orders.shopCreatedAt}) then 1 else 0 end)`,
    })
    .from(orders)
    .where(and(eq(orders.archived, false), inRange(orders.shopCreatedAt)))
    .get();

  const flow = await db
    .select({
      booked: sql<number>`sum(case when ${consignments.createdAt} >= ${range.from} and ${consignments.createdAt} < ${range.to} and ${consignments.consignmentId} is not null then 1 else 0 end)`,
      dispatched: sql<number>`sum(case when ${consignments.pickedUpAt} >= ${range.from} and ${consignments.pickedUpAt} < ${range.to} then 1 else 0 end)`,
      delivered: sql<number>`sum(case when ${consignments.deliveredAt} >= ${range.from} and ${consignments.deliveredAt} < ${range.to} and ${consignments.stage} in ('delivered', 'partial_delivered') then 1 else 0 end)`,
      collected: sql<number>`coalesce(sum(case when ${consignments.deliveredAt} >= ${range.from} and ${consignments.deliveredAt} < ${range.to} and ${consignments.stage} in ('delivered', 'partial_delivered') then coalesce(${consignments.collectedAmount}, ${consignments.codAmount}) end), 0)`,
      charges: sql<number>`coalesce(sum(case when coalesce(${consignments.deliveredAt}, ${consignments.returnedAt}) >= ${range.from} and coalesce(${consignments.deliveredAt}, ${consignments.returnedAt}) < ${range.to} then ${consignments.deliveryCharge} end), 0)`,
      returned: sql<number>`sum(case when ${consignments.returnedAt} >= ${range.from} and ${consignments.returnedAt} < ${range.to} and ${consignments.stage} = 'returned' then 1 else 0 end)`,
    })
    .from(consignments)
    .get();

  // Right now, whatever the range.
  const money = await db
    .select({
      awaitingPayout: sql<number>`coalesce(sum(case when ${consignments.stage} in ('delivered', 'partial_delivered') and ${consignments.paymentId} is null then coalesce(${consignments.collectedAmount}, ${consignments.codAmount}) end), 0)`,
      awaitingPayoutCount: sql<number>`sum(case when ${consignments.stage} in ('delivered', 'partial_delivered') and ${consignments.paymentId} is null then 1 else 0 end)`,
      withCourier: sql<number>`coalesce(sum(case when ${consignments.isFinal} = 0 and ${consignments.superseded} = 0 and ${consignments.pickedUpAt} is not null then ${consignments.codAmount} end), 0)`,
      withCourierCount: sql<number>`sum(case when ${consignments.isFinal} = 0 and ${consignments.superseded} = 0 and ${consignments.pickedUpAt} is not null then 1 else 0 end)`,
    })
    .from(consignments)
    .get();
  const paid = await db
    .select({ amount: sql<number>`coalesce(sum(${payments.amount}), 0)`, count: sql<number>`count(*)` })
    .from(payments)
    .where(sql`substr(${payments.paidAt}, 1, 10) >= ${fromDate} and substr(${payments.paidAt}, 1, 10) <= ${toDate}`)
    .get();

  // Same-day dispatch: orders confirmed before the cut-off that left (handed over or picked up) that day.
  const confirmedRows = await db
    .select({ confirmedAt: orders.confirmedAt, handedOverAt: orders.handedOverAt, dispatchedAt: orders.dispatchedAt, cancelledAt: orders.cancelledAt })
    .from(orders)
    .where(and(eq(orders.archived, false), inRange(orders.confirmedAt)))
    .limit(20_000)
    .all();
  let beforeCutoff = 0;
  let sameDay = 0;
  let nextDay = 0;
  let notYet = 0;
  for (const r of confirmedRows) {
    if (r.cancelledAt || !r.confirmedAt) continue;
    const day = businessDate(r.confirmedAt, offset);
    if (r.confirmedAt >= localTimeIso(day, settings.cutoffTime, offset)) continue;
    beforeCutoff++;
    const left = [r.handedOverAt, r.dispatchedAt].filter(Boolean).sort()[0];
    if (!left) notYet++;
    else if (businessDate(left, offset) === day) sameDay++;
    else nextDay++;
  }

  // Where returns come from: at least the last 30 days so a single day still has enough history.
  const returnsFrom = new Date(Math.min(Date.parse(range.from), Date.parse(range.to) - 30 * DAY)).toISOString();
  const finished = sql`coalesce(${consignments.deliveredAt}, ${consignments.returnedAt}) >= ${returnsFrom} and coalesce(${consignments.deliveredAt}, ${consignments.returnedAt}) < ${range.to}`;
  const deliveredCase = sql`case when ${consignments.stage} in ('delivered', 'partial_delivered') then 1 else 0 end`;
  const returnedCase = sql`case when ${consignments.stage} = 'returned' then 1 else 0 end`;
  const districts = await db
    .select({
      city: sql<string>`max(${orders.city})`,
      delivered: sql<number>`sum(${deliveredCase})`,
      returned: sql<number>`sum(${returnedCase})`,
    })
    .from(consignments)
    .innerJoin(orders, eq(orders.id, consignments.orderId))
    .where(finished)
    .groupBy(sql`lower(trim(coalesce(${orders.city}, '')))`)
    .having(sql`sum(${deliveredCase}) + sum(${returnedCase}) >= 3 and sum(${returnedCase}) > 0`)
    .orderBy(sql`sum(${returnedCase}) * 1.0 / (sum(${deliveredCase}) + sum(${returnedCase})) desc`, sql`sum(${returnedCase}) desc`)
    .limit(8)
    .all();
  const products = await db.all<{ title: string; delivered: number; returned: number }>(sql`
    select json_extract(li.value, '$.title') as title,
      sum(${deliveredCase}) as delivered,
      sum(${returnedCase}) as returned
    from ${consignments}
    join ${orders} on ${orders.id} = ${consignments.orderId}, json_each(${orders.lineItems}) li
    where ${finished}
    group by 1
    having sum(${deliveredCase}) + sum(${returnedCase}) >= 3 and sum(${returnedCase}) > 0
    order by sum(${returnedCase}) * 1.0 / (sum(${deliveredCase}) + sum(${returnedCase})) desc, sum(${returnedCase}) desc
    limit 8`);

  const callers = await db
    .select({
      name: sql<string>`coalesce(${callLogs.userName}, 'Shopify / system')`,
      calls: sql<number>`count(*)`,
      confirmed: sql<number>`sum(case when ${callLogs.outcome} = 'confirmed' then 1 else 0 end)`,
      noAnswer: sql<number>`sum(case when ${callLogs.outcome} = 'no_answer' then 1 else 0 end)`,
      rejected: sql<number>`sum(case when ${callLogs.outcome} = 'rejected' then 1 else 0 end)`,
    })
    .from(callLogs)
    .where(inRange(callLogs.createdAt))
    .groupBy(sql`1`)
    .orderBy(sql`count(*) desc`)
    .all();

  const received = n(cohort?.received);
  const delivered = n(flow?.delivered);
  const returned = n(flow?.returned);
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    from: fromDate,
    to: toDate,
    returnsWindowFrom: businessDate(returnsFrom, offset),
    orders: {
      received,
      value: n(cohort?.value),
      confirmed: n(cohort?.confirmed),
      rejected: n(cohort?.rejected),
      cancelled: n(cohort?.cancelled),
      pending: n(cohort?.pending),
      newCustomers: n(cohort?.newCustomers),
      confirmRate: rate(n(cohort?.confirmed), received),
    },
    courier: {
      booked: n(flow?.booked),
      dispatched: n(flow?.dispatched),
      delivered,
      returned,
      successRate: rate(delivered, delivered + returned),
    },
    sameDay: { cutoffTime: settings.cutoffTime, beforeCutoff, sameDay, nextDay, notYet, rate: rate(sameDay, beforeCutoff) },
    money: {
      collected: n(flow?.collected),
      deliveryCharges: n(flow?.charges),
      paidOut: n(paid?.amount),
      payouts: n(paid?.count),
      awaitingPayout: n(money?.awaitingPayout),
      awaitingPayoutCount: n(money?.awaitingPayoutCount),
      withCourier: n(money?.withCourier),
      withCourierCount: n(money?.withCourierCount),
    },
    worstDistricts: districts.map((d) => ({ city: d.city || "Unknown", delivered: n(d.delivered), returned: n(d.returned), returnRate: rate(n(d.returned), n(d.delivered) + n(d.returned)) })),
    worstProducts: products.map((p) => ({ title: p.title || "Unknown", delivered: n(p.delivered), returned: n(p.returned), returnRate: rate(n(p.returned), n(p.delivered) + n(p.returned)) })),
    callers: callers.map((c) => ({ ...c, calls: n(c.calls), confirmed: n(c.confirmed), noAnswer: n(c.noAnswer), rejected: n(c.rejected) })),
  };
}
