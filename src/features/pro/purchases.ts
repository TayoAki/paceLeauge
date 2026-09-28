import { NativeModules, Platform } from 'react-native';
import Purchases, { type CustomerInfo, type PurchasesPackage } from 'react-native-purchases';

import { env } from '@/config/env';

/**
 * App Store (and later Google Play) purchases of Pro through RevenueCat (docs/ROADMAP.md 3.6).
 * The runner's PaceLeague account id is their RevenueCat app user id, so the server's webhook
 * (server/src/revenuecat.ts) knows whose purchase it is. Purchases happen in the phone app only;
 * the web app shows where to subscribe.
 */
export const PRO_ENTITLEMENT = 'pro';

export const MANAGE_SUBSCRIPTIONS_URL =
  Platform.OS === 'android' ? 'https://play.google.com/store/account/subscriptions' : 'https://apps.apple.com/account/subscriptions';

const apiKey = Platform.OS === 'ios' ? env.revenuecatIosKey : Platform.OS === 'android' ? env.revenuecatAndroidKey : '';

/** False on the web, in Expo Go (no native module) and without a key. */
export function purchasesAvailable(): boolean {
  return apiKey.length > 0 && Platform.OS !== 'web' && !!NativeModules.RNPurchases;
}

let configuredFor: string | null = null;

export async function configurePurchases(userId: string): Promise<void> {
  if (!purchasesAvailable() || configuredFor === userId) return;
  if (configuredFor === null) Purchases.configure({ apiKey, appUserID: userId });
  else await Purchases.logIn(userId);
  configuredFor = userId;
}

const hasPro = (info: CustomerInfo) => info.entitlements.active[PRO_ENTITLEMENT] !== undefined;

export interface ProPackages {
  annual: PurchasesPackage | null;
  monthly: PurchasesPackage | null;
}

export async function proPackages(): Promise<ProPackages | null> {
  if (!purchasesAvailable() || !configuredFor) return null;
  const offerings = await Purchases.getOfferings();
  const current = offerings.current;
  if (!current) return null;
  return { annual: current.annual ?? null, monthly: current.monthly ?? null };
}

export type PurchaseOutcome = 'pro' | 'cancelled' | 'not_pro';

export async function buyPackage(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return hasPro(customerInfo) ? 'pro' : 'not_pro';
  } catch (error) {
    if ((error as { userCancelled?: boolean }).userCancelled) return 'cancelled';
    throw error;
  }
}

export async function restorePurchases(): Promise<boolean> {
  if (!purchasesAvailable() || !configuredFor) return false;
  return hasPro(await Purchases.restorePurchases());
}
