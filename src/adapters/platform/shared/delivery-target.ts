import type { DeliveryTarget, JsonObject } from "../../../core/types.js";

export function createDeliveryTarget(platform: string, payload: JsonObject): DeliveryTarget {
  return {
    platform,
    payload,
  };
}
