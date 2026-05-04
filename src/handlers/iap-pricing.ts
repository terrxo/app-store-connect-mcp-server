import { AppStoreConnectClient } from '../services/index.js';
import { validateRequired } from '../utils/index.js';
import {
  ListIapPricePointsResponse,
  IapPriceScheduleResponse,
  ManualPriceInput,
  ResolvedManualPrice,
  SetIapPricesArgs,
  SetIapPricesResult,
} from '../types/index.js';

const ASC_BASE_V2 = 'https://api.appstoreconnect.apple.com/v2';

export class IapPricingHandlers {
  constructor(private client: AppStoreConnectClient) {}

  /**
   * List Apple's available price points for an IAP. Apple supports `filter[territory]`
   * (server-side) but NOT `filter[customerPrice]` — when customerPrice is provided here,
   * we paginate the territory's price points and filter client-side until we find the
   * match (or exhaust pagination).
   *
   * Note: requires the V2 IAP ID (e.g., '6753804205'), NOT the V1 UUID. The V2 ID is
   * the same as the App Store Connect numeric IAP ID and can be discovered by querying
   * the app's `inAppPurchasesV2` relationship.
   */
  async listPricePoints(args: {
    iapId: string;
    territory?: string;
    customerPrice?: string;
    limit?: number;
  }): Promise<ListIapPricePointsResponse> {
    validateRequired(args, ['iapId']);
    const { iapId, territory, customerPrice } = args;
    const limit = Math.min(args.limit ?? 200, 200); // Apple caps at 200 per page

    // Fast path: no customerPrice filter — single page
    if (!customerPrice) {
      const params: Record<string, any> = { limit };
      if (territory) params['filter[territory]'] = territory;
      return this.client.get<ListIapPricePointsResponse>(
        `${ASC_BASE_V2}/inAppPurchases/${iapId}/pricePoints`,
        params
      );
    }

    // customerPrice filter requires client-side filtering — paginate until found
    if (!territory) {
      throw new Error('When filtering by customerPrice, territory is required.');
    }

    const allMatches: any[] = [];
    let cursor: string | undefined;
    const pageSize = 200;
    let pagesFetched = 0;
    const MAX_PAGES = 10; // up to 2000 price points per territory — should be plenty

    while (pagesFetched < MAX_PAGES) {
      const params: Record<string, any> = {
        'filter[territory]': territory,
        limit: pageSize,
      };
      if (cursor) params['cursor'] = cursor;

      const page = await this.client.get<ListIapPricePointsResponse>(
        `${ASC_BASE_V2}/inAppPurchases/${iapId}/pricePoints`,
        params
      );
      pagesFetched++;

      for (const pp of page.data ?? []) {
        if (pp.attributes?.customerPrice === customerPrice) {
          allMatches.push(pp);
        }
      }

      // If we found at least one match, stop early.
      if (allMatches.length > 0) break;

      // Pagination via `links.next`
      const nextUrl = (page.links as any)?.next as string | undefined;
      if (!nextUrl) break;
      const nextCursor = new URL(nextUrl).searchParams.get('cursor');
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    return {
      data: allMatches,
      meta: { paging: { total: allMatches.length, limit: pageSize } },
    };
  }

  /**
   * Get the current IAP price schedule with its manualPrices, automaticPrices, and baseTerritory.
   * Uses the V2 IAP relationship endpoint (the schedule resource itself isn't directly
   * fetchable via /v2/inAppPurchasePriceSchedules/{id} — only via the relationship).
   * Returns null-shaped result if the IAP has no schedule yet.
   */
  async getPriceSchedule(args: { iapId: string }): Promise<{
    scheduleId: string | null;
    schedule: IapPriceScheduleResponse | null;
    manualPrices: Array<{
      priceId: string;
      territory: string;
      pricePointId: string;
      customerPrice: string | null;
    }>;
    automaticPrices: Array<{
      priceId: string;
      territory: string;
      pricePointId: string;
    }>;
    baseTerritory: string | null;
  }> {
    validateRequired(args, ['iapId']);

    let scheduleResp: IapPriceScheduleResponse;
    try {
      scheduleResp = await this.client.get<IapPriceScheduleResponse>(
        `${ASC_BASE_V2}/inAppPurchases/${args.iapId}/iapPriceSchedule`,
        { include: 'manualPrices,automaticPrices,baseTerritory' }
      );
    } catch (e: any) {
      // 404 = no schedule yet
      if (e?.response?.status === 404) {
        return {
          scheduleId: null,
          schedule: null,
          manualPrices: [],
          automaticPrices: [],
          baseTerritory: null,
        };
      }
      throw e;
    }

    const included = scheduleResp.included ?? [];
    const scheduleId = scheduleResp.data?.id ?? null;

    const baseTerritory =
      scheduleResp.data?.relationships?.baseTerritory?.data?.id ?? null;

    const summarize = (priceRefs?: Array<{ type: string; id: string }>) => {
      if (!priceRefs) return [];
      return priceRefs
        .map((ref) => included.find((i: any) => i.id === ref.id))
        .filter(Boolean)
        .map((p: any) => ({
          priceId: p.id,
          territory: p.relationships?.territory?.data?.id ?? 'unknown',
          pricePointId: p.relationships?.inAppPurchasePricePoint?.data?.id ?? 'unknown',
        }));
    };

    const manualPrices = summarize(
      scheduleResp.data?.relationships?.manualPrices?.data
    ).map((p) => ({ ...p, customerPrice: null }));

    const automaticPrices = summarize(
      scheduleResp.data?.relationships?.automaticPrices?.data
    );

    return {
      scheduleId,
      schedule: scheduleResp,
      manualPrices,
      automaticPrices,
      baseTerritory,
    };
  }

  /**
   * Replace the IAP's price schedule with a new manual-prices set. WRITES TO APPLE.
   *
   * For each ManualPriceInput, resolves the corresponding price-point ID by querying
   * Apple's available price points (unless `pricePointId` is pre-provided). Then POSTs
   * a new schedule with the manual prices. The new schedule replaces the existing one.
   *
   * If `dryRun: true`, returns the planned payload without POSTing.
   */
  async setPrices(args: SetIapPricesArgs & { dryRun?: boolean }): Promise<SetIapPricesResult> {
    validateRequired(args, ['iapId', 'manualPrices']);
    const { iapId, manualPrices, baseTerritory = 'USA', dryRun = false } = args;

    if (!Array.isArray(manualPrices) || manualPrices.length === 0) {
      throw new Error('manualPrices must be a non-empty array');
    }

    // Resolve each manual price's price-point ID
    const resolvedPrices: ResolvedManualPrice[] = [];

    for (const mp of manualPrices) {
      let pricePointId = mp.pricePointId;
      let resolvedCustomerPrice = mp.customerPrice;

      if (!pricePointId) {
        if (!mp.customerPrice) {
          throw new Error(
            `manualPrices[].customerPrice or pricePointId required (territory=${mp.territory})`
          );
        }

        // Apple doesn't support filter[customerPrice] — use the paginated client-side
        // matcher in listPricePoints.
        const pointsResp = await this.listPricePoints({
          iapId,
          territory: mp.territory,
          customerPrice: mp.customerPrice,
        });

        const matching = pointsResp.data?.[0];
        if (!matching) {
          throw new Error(
            `No price point found for territory=${mp.territory} customerPrice=${mp.customerPrice}. ` +
              `Use list_iap_price_points (without customerPrice filter) to see available prices for this territory.`
          );
        }
        pricePointId = matching.id;
        resolvedCustomerPrice = matching.attributes?.customerPrice ?? mp.customerPrice;
      }

      resolvedPrices.push({
        territory: mp.territory,
        pricePointId,
        customerPrice: resolvedCustomerPrice,
      });
    }

    // Apple requires inline-creation local IDs in the format `${local-id}` literally
    const tempIds = resolvedPrices.map((_, i) => `\${manual-${i}}`);

    const included = resolvedPrices.map((rp, i) => ({
      type: 'inAppPurchasePrices',
      id: tempIds[i],
      attributes: {
        startDate: null,
        endDate: null,
      },
      relationships: {
        inAppPurchasePricePoint: {
          data: {
            type: 'inAppPurchasePricePoints',
            id: rp.pricePointId,
          },
        },
        territory: {
          data: {
            type: 'territories',
            id: rp.territory,
          },
        },
      },
    }));

    const payload = {
      data: {
        type: 'inAppPurchasePriceSchedules',
        relationships: {
          inAppPurchase: {
            data: {
              type: 'inAppPurchases',
              id: iapId,
            },
          },
          manualPrices: {
            data: tempIds.map((id) => ({ type: 'inAppPurchasePrices', id })),
          },
          baseTerritory: {
            data: {
              type: 'territories',
              id: baseTerritory,
            },
          },
        },
      },
      included,
    };

    if (dryRun) {
      return {
        message: `DRY RUN — would POST schedule with ${resolvedPrices.length} manual prices to baseTerritory=${baseTerritory}. No changes made.`,
        scheduleId: '(dry-run)',
        resolvedPrices,
        payload,
      };
    }

    // Schedule create endpoint is V1 (shared between V1/V2 IAPs); V2 IAPs reference it
    // via the iapPriceSchedule relationship.
    const response: any = await this.client.post(
      'https://api.appstoreconnect.apple.com/v1/inAppPurchasePriceSchedules',
      payload
    );

    return {
      message: `Created new IAP price schedule for ${iapId} with ${resolvedPrices.length} manual prices`,
      scheduleId: response?.data?.id ?? '(unknown)',
      resolvedPrices,
    };
  }
}
