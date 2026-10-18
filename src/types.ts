// API response shapes used by the dashboard.

export type LineItem = {
  id: string;
  title: string;
  variantTitle?: string | null;
  sku?: string | null;
  quantity: number;
  fulfillableQuantity?: number | null;
  price: number;
};

export type Booking = {
  recipientName: string;
  recipientPhone: string;
  alternativePhone?: string;
  recipientEmail?: string;
  recipientAddress: string;
  codAmount: number;
  note?: string;
  itemDescription?: string;
  totalLot?: number;
  deliveryType: 0 | 1;
  lineItems?: { lineItemId: string; quantity: number }[];
};

export type CustomStatus = { id: number; name: string; color: string; sortOrder: number; isDefault: boolean; blocksBooking: boolean };

export type OrderListRow = {
  id: number;
  shopifyId: string;
  name: string;
  shopCreatedAt: string;
  customerName: string | null;
  phone: string | null;
  rawPhone: string | null;
  city: string | null;
  address1: string | null;
  total: number;
  outstanding: number;
  currency: string;
  financialStatus: string | null;
  shopifyFulfillmentStatus: string | null;
  cancelledAt: string | null;
  statusId: number | null;
  internalTags: string[] | null;
  riskFlags: string[] | null;
  riskDismissed: boolean;
  courierStage: string;
  fulfillmentState: string;
  fulfillmentError: string | null;
  itemCount: number;
  trackingCode: string | null;
  consignmentStatus: string | null;
  consignmentCod: number | null;
  callingStatus: string;
  callAttempts: number;
  callbackAt: string | null;
  processingStatus: string;
  shopifySyncStatus: string;
  labelStatus: string;
  dispatchStatus: string;
  cancelRequestedAt: string | null;
  autoBookAt: string | null;
  autoBookNote: string | null;
  customerId: number | null;
  customerOrders: number;
  customerDelivered: number;
  customerReturned: number;
  customerFlag: string | null;
};

export type Order = Omit<OrderListRow, "itemCount" | "trackingCode" | "consignmentStatus" | "consignmentCod" | "customerOrders" | "customerDelivered" | "customerReturned" | "customerFlag"> & {
  orderNumber: number | null;
  shopUpdatedAt: string;
  cancelReason: string | null;
  customerId: number | null;
  email: string | null;
  address2: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  subtotal: number;
  shippingTotal: number;
  discountTotal: number;
  paymentGateways: string[] | null;
  shippingMethod: string | null;
  lineItems: LineItem[];
  shopifyTags: string[] | null;
  shopifyNote: string | null;
  noteAttributes: { name: string; value: string }[] | null;
  sourceName: string | null;
  customerRemark: string | null;
  duplicateOfOrderId: number | null;
  booking: Partial<Booking> | null;
  activeConsignmentId: number | null;
  shopifyFulfillmentIds: string[] | null;
  fulfilledAt: string | null;
  archived: boolean;
  confirmedAt: string | null;
  lastCallAt: string | null;
  shopifySyncError: string | null;
  bookedAt: string | null;
  printedAt: string | null;
  printCount: number;
  printJobId: string | null;
  sortedAt: string | null;
  sortedBy: string | null;
  dispatchedAt: string | null;
};

export type CallLog = { id: number; outcome: string; note: string | null; callbackAt: string | null; userName: string | null; createdAt: string };
export type DispatchEvent = { id: number; orderId: number; event: string; jobId: string | null; actor: string; note: string | null; createdAt: string };

export type Consignment = {
  id: number;
  orderId: number;
  invoice: string;
  consignmentId: string | null;
  trackingCode: string | null;
  trackingUrl?: string | null;
  status: string;
  stage: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  codAmount: number;
  collectedAmount: number | null;
  deliveryCharge: number | null;
  note: string | null;
  deliveryType: number;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  returnedAt: string | null;
  lastStatusAt: string | null;
  lastPolledAt: string | null;
  lastMessage: string | null;
  isFinal: boolean;
  superseded: boolean;
  paymentId: string | null;
  settledAt: string | null;
  createdAt: string;
  orderName?: string;
  fulfillmentState?: string;
  orderCancelledAt?: string | null;
};

export type TrackingEvent = {
  id: number;
  consignmentRowId: number;
  kind: string;
  status: string | null;
  message: string | null;
  source: string;
  occurredAt: string;
};

export type Note = { id: number; kind: string; body: string; rating: number | null; userId: number | null; userName: string | null; createdAt: string; orderName?: string | null };

export type Activity = { id: number; actor: string; action: string; entityType: string | null; entityId: string | null; orderId: number | null; orderName?: string | null; details: unknown; createdAt: string };

export type ReturnRow = {
  id: number;
  orderId: number;
  consignmentRowId: number | null;
  type: string;
  reason: string | null;
  status: string;
  steadfastReturnId: string | null;
  steadfastReturnStatus: string | null;
  condition: string | null;
  restockConfirmed: boolean;
  refundConfirmed: boolean;
  followUpAction: string | null;
  followUpAt: string | null;
  notes: string | null;
  receivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  orderName?: string;
  customerName?: string | null;
  phone?: string | null;
  customerId?: number | null;
  total?: number;
  trackingCode?: string | null;
  consignmentId?: string | null;
  consignmentStatus?: string | null;
};

export type Customer = {
  id: number;
  phone: string;
  name: string | null;
  email: string | null;
  note: string | null;
  tags: string[] | null;
  flag: string | null;
  createdAt: string;
};

export type History = { orders: number; delivered: number; returned: number; cancelledOrders: number; collected: number; successRate: number | null };

export type OrderDetail = {
  order: Order;
  booking: Booking;
  defaultBooking: Booking;
  customer: Customer | null;
  history: History | null;
  otherOrders: { id: number; name: string; shopCreatedAt: string; total: number; courierStage: string; cancelledAt: string | null }[];
  consignments: Consignment[];
  events: TrackingEvent[];
  notes: Note[];
  activity: Activity[];
  returns: ReturnRow[];
  calls: CallLog[];
  dispatchHistory: DispatchEvent[];
  shopifyUrl: string;
};
