import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

const taka = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const takaDecimals = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

export const money = (n: number | null | undefined, decimals = false) =>
  n === null || n === undefined ? "—" : `৳${(decimals ? takaDecimals : taka).format(n)}`;
export const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : taka.format(n));
export const dateTime = (s: string | null | undefined) => (s ? dayjs(s).format("D MMM YYYY, h:mm A") : "—");
export const dateShort = (s: string | null | undefined) => (s ? dayjs(s).format("D MMM, h:mm A") : "—");
export const day = (s: string | null | undefined) => (s ? dayjs(s).format("D MMM YYYY") : "—");
export const ago = (s: string | null | undefined) => (s ? dayjs(s).fromNow() : "—");
export const titleCase = (s: string | null | undefined) =>
  s ? s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "—";
