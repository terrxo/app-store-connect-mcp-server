/**
 * Types for In-App Purchase pricing endpoints (App Store Connect V2 API).
 *
 * Apple's IAP pricing model:
 * - Each IAP has an `inAppPurchasePriceSchedule` resource.
 * - The schedule has `manualPrices` (territory-specific, fixed) and `automaticPrices`
 *   (auto-tracking from baseTerritory).
 * - Each price entry references an `inAppPurchasePricePoint`, which is a precomputed
 *   (territory + customerPrice) tuple. To set "USD $9.99", you find the price point
 *   where territory=USA and customerPrice="9.99", then reference its ID in a manual price.
 * - POST to `/v2/inAppPurchasePriceSchedules` REPLACES the existing schedule wholesale.
 *
 * Endpoints used:
 * - GET  /v2/inAppPurchases/{id}/pricePoints
 * - GET  /v2/inAppPurchases/{id}/iapPriceSchedule
 * - GET  /v2/inAppPurchasePriceSchedules/{id}/manualPrices
 * - GET  /v2/inAppPurchasePriceSchedules/{id}/automaticPrices
 * - GET  /v2/inAppPurchasePriceSchedules/{id}/baseTerritory
 * - POST /v2/inAppPurchasePriceSchedules
 */

export interface IapPricePoint {
  id: string;
  type: 'inAppPurchasePricePoints';
  attributes: {
    customerPrice: string;
    proceeds: string;
    proceedsYear2?: string;
  };
  relationships?: {
    territory?: {
      data?: { type: 'territories'; id: string };
    };
  };
}

export interface ListIapPricePointsResponse {
  data: IapPricePoint[];
  included?: any[];
  links?: { self?: string; next?: string };
  meta?: { paging?: { total: number; limit: number } };
}

export interface IapPrice {
  id: string;
  type: 'inAppPurchasePrices';
  attributes?: {
    startDate?: string | null;
    endDate?: string | null;
  };
  relationships?: {
    inAppPurchasePricePoint?: { data?: { type: string; id: string } };
    territory?: { data?: { type: 'territories'; id: string } };
  };
}

export interface IapPriceSchedule {
  id: string;
  type: 'inAppPurchasePriceSchedules';
  relationships?: {
    inAppPurchase?: { data: { type: string; id: string } };
    manualPrices?: { data?: Array<{ type: string; id: string }> };
    automaticPrices?: { data?: Array<{ type: string; id: string }> };
    baseTerritory?: { data?: { type: 'territories'; id: string } };
  };
}

export interface IapPriceScheduleResponse {
  data: IapPriceSchedule;
  included?: Array<IapPrice | { id: string; type: string; attributes?: any; relationships?: any }>;
}

export interface ManualPriceInput {
  /** Territory ID (e.g., "USA", "GBR", "CHE", "AUS", "NZL", "CAN", "NOR", "DNK", "SWE", "DEU"). */
  territory: string;
  /** Customer-facing price as a string, e.g., "9.99". Looked up against price points. */
  customerPrice?: string;
  /** Pre-resolved price point ID (skip lookup). Either customerPrice OR pricePointId required. */
  pricePointId?: string;
}

export interface SetIapPricesArgs {
  iapId: string;
  /** Full list of territories with manual prices. Replaces existing manualPrices. */
  manualPrices: ManualPriceInput[];
  /** Anchor territory whose price drives auto-tracked territories. Default 'USA'. */
  baseTerritory?: string;
  /**
   * Whether to preserve existing automaticPrices. Default true — territories not in
   * manualPrices keep their existing auto-tracking behavior. Set false to clear them
   * (Apple will fall back to baseTerritory-based auto-pricing).
   */
  preserveAutomatic?: boolean;
}

export interface ResolvedManualPrice {
  territory: string;
  pricePointId: string;
  customerPrice?: string;
}

export interface SetIapPricesResult {
  message: string;
  scheduleId: string;
  resolvedPrices: ResolvedManualPrice[];
  payload?: any; // included on dryRun
}
