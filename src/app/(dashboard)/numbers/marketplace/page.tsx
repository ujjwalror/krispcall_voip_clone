'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  ArrowLeft,
  Search,
  Globe,
  Sliders,
  AlertTriangle,
  RefreshCw,
  Phone,
  MessageSquare,
  Volume2,
  Info,
  Building2,
  User,
  MapPin,
  Tag,
  ShoppingBag,
  XCircle,
  Trash2,
  Loader2,
  FileText,
  CheckCircle,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { StripePaymentElementModal } from '@/components/billing/StripePaymentElementModal';

export interface CountryOption {
  countryCode: string;
  countryName: string;
  supportedTypes: Array<'local' | 'mobile' | 'toll_free'>;
}

export interface FilterCapabilities {
  contains: boolean;
  areaCode: boolean;
  locality: boolean;
  region: boolean;
  postalCode: boolean;
  voiceCapabilities: boolean;
  smsCapabilities: boolean;
  mmsCapabilities: boolean;
}

export interface InventoryNumberItem {
  provider: 'twilio';
  providerReference: string;
  phoneNumber: string;
  friendlyDisplay: string;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free';
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  addressRequirements: string | null;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
  beta: boolean | null;
  regulatoryMetadata: {
    addressRequirements: string | null;
    bundleStatus: 'not_evaluated';
  } | null;
}

export interface EntitlementsInfo {
  currentActive: number;
  maxActive: number | null;
  canPurchaseMore: boolean;
}

export type RegulatoryPreCheckStatus =
  | 'not_evaluated'
  | 'checking'
  | 'no_additional_requirements'
  | 'requirements_found'
  | 'unavailable'
  | 'error';

export interface PreCheckResult {
  status: RegulatoryPreCheckStatus;
  regulationId: string | null;
  countryCode: string;
  numberType: string;
  endUserType: 'business' | 'individual';
  addressRequirement: string | null;
  endUserRequirements: Array<{ fieldKey?: string; friendlyName?: string; type?: string; description?: string; required?: boolean }>;
  supportingDocumentRequirements: Array<{ requirementKey?: string; name?: string; type?: string; description?: string }>;
  bundleRequired: boolean;
  message: string;
}

export interface CartItem {
  id: string;
  phoneNumber: string;
  friendlyDisplay: string;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free';
  endUserType: 'business' | 'individual';
  locality?: string | null;
  region?: string | null;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  priceFormatted: string | null;
  hasConfiguredPrice: boolean;
  preCheckStatus: RegulatoryPreCheckStatus;
  bundleRequired: boolean;
  readinessState?: string;
  readinessMessage?: string;
  nextAction?: 'verification' | 'payment' | 'unavailable';
  priceChanged?: boolean;
}

export default function NumberMarketplacePage() {
  const { profile } = useAuth();
  const canManage = profile?.role === 'owner' || profile?.role === 'admin';

  // Countries & Filter State
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [selectedCountry, setSelectedCountry] = useState<string>('US');
  const [selectedType, setSelectedType] = useState<'local' | 'mobile' | 'toll_free'>('local');

  // Dynamic Filters State
  const [containsInput, setContainsInput] = useState<string>('');
  const [areaCodeInput, setAreaCodeInput] = useState<string>('');
  const [localityInput, setLocalityInput] = useState<string>('');
  const [regionInput, setRegionInput] = useState<string>('');
  const [postalCodeInput, setPostalCodeInput] = useState<string>('');

  const [voiceOnly, setVoiceOnly] = useState<boolean>(false);
  const [smsOnly, setSmsOnly] = useState<boolean>(false);
  const [mmsOnly, setMmsOnly] = useState<boolean>(false);

  // Search Results & Metadata State
  const [numbers, setNumbers] = useState<InventoryNumberItem[]>([]);
  const [filterCapabilities, setFilterCapabilities] = useState<FilterCapabilities>({
    contains: true,
    areaCode: true,
    locality: true,
    region: true,
    postalCode: true,
    voiceCapabilities: true,
    smsCapabilities: true,
    mmsCapabilities: true,
  });
  const [entitlements, setEntitlements] = useState<EntitlementsInfo | null>(null);

  // Pagination State
  const [continuationToken, setContinuationToken] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);

  // Loading & Error States
  const [isLoadingCountries, setIsLoadingCountries] = useState<boolean>(true);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Selected Number Selection & Pre-Check Modal
  const [selectedNumber, setSelectedNumber] = useState<InventoryNumberItem | null>(null);
  const [endUserType, setEndUserType] = useState<'business' | 'individual'>('business');
  const [isEvaluatingPreCheck, setIsEvaluatingPreCheck] = useState<boolean>(false);
  const [preCheckResult, setPreCheckResult] = useState<PreCheckResult | null>(null);

  // Authoritative Server Retail Price State for Selection
  const [isResolvingPrice, setIsResolvingPrice] = useState<boolean>(false);
  const [resolvedPrice, setResolvedPrice] = useState<{
    hasConfiguredPrice: boolean;
    monthlyPriceFormatted: string | null;
    currency: string;
  } | null>(null);

  // Temporary Cart Drawer State
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState<boolean>(false);
  const [isAddingToCart, setIsAddingToCart] = useState<boolean>(false);
  const [cartFeedback, setCartFeedback] = useState<string | null>(null);

  // Stripe Checkout Modal State (Phase 13.2)
  const [isCheckoutModalOpen, setIsCheckoutModalOpen] = useState<boolean>(false);
  const [checkoutSelection, setCheckoutSelection] = useState<{
    phoneNumber: string;
    countryCode: string;
    numberType: string;
    monthlyRetailMinor?: number;
    currency?: string;
  } | null>(null);

  const handleOpenCheckoutModal = (item: CartItem) => {
    let minor = 315;
    if (item.priceFormatted) {
      const parsed = parseFloat(item.priceFormatted.replace(/[^0-9.]/g, ''));
      if (!isNaN(parsed) && parsed > 0) {
        minor = Math.round(parsed * 100);
      }
    }

    setCheckoutSelection({
      phoneNumber: item.phoneNumber,
      countryCode: item.countryCode,
      numberType: item.numberType,
      monthlyRetailMinor: minor,
      currency: 'USD',
    });
    setIsCheckoutModalOpen(true);
  };

  // Phase 12.4 Purchase Execution & Status Polling State
  const [purchasingItemId, setPurchasingItemId] = useState<string | null>(null);
  const [activeOperation, setActiveOperation] = useState<{
    id: string;
    status: string;
    customerStatusWording: string;
    isTerminal: boolean;
  } | null>(null);

  const pollingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Map internal database operation status to customer-safe wording
  const mapCustomerStatusWording = (status: string): string => {
    switch (status) {
      case 'pending':
        return 'Preparing your number...';
      case 'in_progress':
        return 'Activating your number...';
      case 'reconciliation_required':
        return "We're confirming your number activation...";
      case 'manual_review_required':
        return "We're reviewing your number activation...";
      case 'succeeded':
        return 'Your number is active';
      case 'failed':
        return 'Activation could not be completed';
      default:
        return 'Processing request...';
    }
  };

  // Bounded status polling with backoff strategy and automatic cleanup
  const pollOperationStatusBounded = useCallback((opId: string) => {
    let attempts = 0;
    const maxAttempts = 10;
    const pollIntervals = [2000, 2000, 3000, 3000, 5000, 5000, 5000, 5000, 5000, 5000];

    const scheduleNextPoll = () => {
      if (attempts >= maxAttempts) {
        console.log('[Marketplace] Bounded status polling reached maximum attempt limit.');
        return;
      }
      const delay = pollIntervals[attempts] || 5000;
      attempts++;

      pollingTimerRef.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/number-marketplace/operations/${opId}`);
          if (res.ok) {
            const json = await res.json();
            const op = json.operation;
            if (op) {
              const wording = mapCustomerStatusWording(op.status);
              const isTerminal = op.status === 'succeeded' || op.status === 'failed';
              setActiveOperation({
                id: op.id,
                status: op.status,
                customerStatusWording: wording,
                isTerminal,
              });

              if (!isTerminal) {
                scheduleNextPoll();
              }
            }
          }
        } catch (err) {
          console.error('[Marketplace] Error polling operation status:', err);
        }
      }, delay);
    };

    scheduleNextPoll();
  }, []);

  // Cleanup polling timer on unmount
  useEffect(() => {
    return () => {
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
      }
    };
  }, []);

  // Purchase CTA Handler
  const handleExecutePurchase = async (cartItem: CartItem) => {
    setPurchasingItemId(cartItem.id);
    setCartFeedback(null);

    try {
      const idempotencyKey = `purch_${cartItem.id}_${Date.now()}`;
      const res = await fetch('/api/number-marketplace/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumberE164: cartItem.phoneNumber,
          countryCode: cartItem.countryCode,
          numberType: cartItem.numberType,
          idempotencyKey,
          endUserType: cartItem.endUserType,
        }),
      });

      if (res.status === 402) {
        // Pre-Phase 13 Server Payment Boundary Gate
        setCartFeedback(
          'Checkout is not available yet. Payment authorization is required before this number can be activated.'
        );
        return;
      }

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        setCartFeedback(errJson.error || 'Failed to process purchase request.');
        return;
      }

      const json = await res.json();
      if (json.success && json.operation) {
        const op = json.operation;
        const wording = mapCustomerStatusWording(op.status);
        const isTerminal = op.status === 'succeeded' || op.status === 'failed';

        setActiveOperation({
          id: op.id,
          status: op.status,
          customerStatusWording: wording,
          isTerminal,
        });

        if (!isTerminal) {
          pollOperationStatusBounded(op.id);
        }
      }
    } catch (err: any) {
      console.error('[Marketplace] Error executing purchase:', err);
      setCartFeedback('Network error executing purchase request. Please try again.');
    } finally {
      setPurchasingItemId(null);
    }
  };

  // 1. Fetch available countries
  const fetchCountries = useCallback(async () => {
    setIsLoadingCountries(true);
    try {
      const res = await fetch('/api/number-marketplace/countries');
      if (res.ok) {
        const json = await res.json();
        setCountries(json.countries || []);
        if (json.countries && json.countries.length > 0) {
          setSelectedCountry((prev) => {
            const exists = json.countries.some((c: CountryOption) => c.countryCode === prev);
            return exists ? prev : json.countries[0].countryCode;
          });
        }
      }
    } catch (err) {
      console.error('[Marketplace] Error fetching countries:', err);
    } finally {
      setIsLoadingCountries(false);
    }
  }, []);

  useEffect(() => {
    fetchCountries();
  }, [fetchCountries]);

  // Derive supported number types for currently selected country
  const currentCountryObj = countries.find((c) => c.countryCode === selectedCountry);
  const supportedNumberTypes = currentCountryObj?.supportedTypes || ['local', 'mobile', 'toll_free'];

  useEffect(() => {
    if (!supportedNumberTypes.includes(selectedType)) {
      setSelectedType(supportedNumberTypes[0] || 'local');
    }
  }, [selectedCountry, supportedNumberTypes, selectedType]);

  // Reset continuation token whenever search filters change
  useEffect(() => {
    setContinuationToken(null);
    setHasMore(false);
  }, [
    selectedCountry,
    selectedType,
    containsInput,
    areaCodeInput,
    localityInput,
    regionInput,
    postalCodeInput,
    voiceOnly,
    smsOnly,
    mmsOnly,
  ]);

  // 2. Perform initial inventory search
  const performSearch = useCallback(async () => {
    setIsSearching(true);
    setSearchError(null);
    setContinuationToken(null);
    try {
      const queryParams = new URLSearchParams();
      queryParams.set('country', selectedCountry);
      queryParams.set('type', selectedType);
      queryParams.set('limit', '50');
      if (containsInput.trim()) queryParams.set('contains', containsInput.trim());
      if (areaCodeInput.trim()) queryParams.set('areaCode', areaCodeInput.trim());
      if (localityInput.trim()) queryParams.set('locality', localityInput.trim());
      if (regionInput.trim()) queryParams.set('region', regionInput.trim());
      if (postalCodeInput.trim()) queryParams.set('postalCode', postalCodeInput.trim());
      if (voiceOnly) queryParams.set('voice', 'true');
      if (smsOnly) queryParams.set('sms', 'true');
      if (mmsOnly) queryParams.set('mms', 'true');

      const res = await fetch(`/api/number-marketplace/search?${queryParams.toString()}`);
      const json = await res.json();

      if (res.ok && json.success) {
        const fetchedNumbers: InventoryNumberItem[] = json.numbers || [];
        setNumbers(fetchedNumbers);
        setHasMore(Boolean(json.hasMore));
        setContinuationToken(json.continuationToken || null);
        if (json.filterCapabilities) {
          setFilterCapabilities(json.filterCapabilities);
        }
        if (json.entitlements) {
          setEntitlements(json.entitlements);
        }
      } else {
        setSearchError(json.error || 'Failed to search phone number inventory.');
      }
    } catch (err) {
      console.error('[Marketplace] Inventory search error:', err);
      setSearchError('Network error searching inventory. Please try again.');
    } finally {
      setIsSearching(false);
    }
  }, [
    selectedCountry,
    selectedType,
    containsInput,
    areaCodeInput,
    localityInput,
    regionInput,
    postalCodeInput,
    voiceOnly,
    smsOnly,
    mmsOnly,
  ]);

  // Load next provider page via continuation token
  const handleLoadMore = async () => {
    if (!hasMore || !continuationToken || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const queryParams = new URLSearchParams();
      queryParams.set('country', selectedCountry);
      queryParams.set('type', selectedType);
      queryParams.set('limit', '50');
      queryParams.set('pageToken', continuationToken);
      if (containsInput.trim()) queryParams.set('contains', containsInput.trim());
      if (areaCodeInput.trim()) queryParams.set('areaCode', areaCodeInput.trim());
      if (localityInput.trim()) queryParams.set('locality', localityInput.trim());
      if (regionInput.trim()) queryParams.set('region', regionInput.trim());
      if (postalCodeInput.trim()) queryParams.set('postalCode', postalCodeInput.trim());
      if (voiceOnly) queryParams.set('voice', 'true');
      if (smsOnly) queryParams.set('sms', 'true');
      if (mmsOnly) queryParams.set('mms', 'true');

      const res = await fetch(`/api/number-marketplace/search?${queryParams.toString()}`);
      const json = await res.json();

      if (res.ok && json.success) {
        const newNumbers: InventoryNumberItem[] = json.numbers || [];
        setNumbers((prevNumbers) => {
          const existingSet = new Set(prevNumbers.map((item) => item.phoneNumber));
          const uniqueNewItems = newNumbers.filter((item) => !existingSet.has(item.phoneNumber));
          return [...prevNumbers, ...uniqueNewItems];
        });
        setHasMore(Boolean(json.hasMore));
        setContinuationToken(json.continuationToken || null);
      } else {
        console.warn('[Marketplace] Load More failed:', json.error);
      }
    } catch (err) {
      console.error('[Marketplace] Load More network error:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    performSearch();
  }, [performSearch]);

  const preCheckReqIdRef = useRef(0);
  const preCheckCacheRef = useRef<Record<string, PreCheckResult>>({});

  // 3. Evaluate regulatory pre-check & server price when modal opens / endUserType changes
  const evaluatePreCheckAndPrice = useCallback(
    async (num: InventoryNumberItem, userType: 'business' | 'individual') => {
      const currentReqId = ++preCheckReqIdRef.current;
      const cacheKey = `${num.countryCode}__${num.numberType}__${userType}`;

      setIsResolvingPrice(true);
      setResolvedPrice(null);

      const cached = preCheckCacheRef.current[cacheKey];
      if (cached) {
        setPreCheckResult(cached);
        setIsEvaluatingPreCheck(false);
      } else {
        setPreCheckResult(null); // Clear stale requirements immediately!
        setIsEvaluatingPreCheck(true);
      }

      try {
        const fetchPromises: Promise<any>[] = [
          fetch('/api/number-marketplace/cart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              candidate: {
                phoneNumber: num.phoneNumber,
                countryCode: num.countryCode,
                numberType: num.numberType,
                friendlyDisplay: num.friendlyDisplay,
                endUserType: userType,
                locality: num.locality,
                region: num.region,
                capabilities: num.capabilities,
              },
            }),
          }),
        ];

        if (!cached) {
          fetchPromises.unshift(
            fetch(`/api/number-marketplace/regulatory-precheck?countryCode=${num.countryCode}&numberType=${num.numberType}&endUserType=${userType}`)
          );
        }

        const responses = await Promise.all(fetchPromises);
        if (currentReqId !== preCheckReqIdRef.current) {
          // Stale request! Discard because user rapidly switched registration type again.
          return;
        }

        let preCheckRes = !cached ? responses[0] : null;
        let cartValRes = !cached ? responses[1] : responses[0];

        if (preCheckRes) {
          const preCheckJson = await preCheckRes.json();
          if (preCheckRes.ok && preCheckJson.success && preCheckJson.preCheck) {
            preCheckCacheRef.current[cacheKey] = preCheckJson.preCheck;
            setPreCheckResult(preCheckJson.preCheck);
          } else {
            setPreCheckResult({
              status: 'unavailable',
              regulationId: null,
              countryCode: num.countryCode,
              numberType: num.numberType,
              endUserType: userType,
              addressRequirement: null,
              endUserRequirements: [],
              supportingDocumentRequirements: [],
              bundleRequired: false,
              message: 'Verification requirement lookup is temporarily unavailable.',
            });
          }
        }

        if (cartValRes) {
          const cartValJson = await cartValRes.json();
          if (cartValRes.ok && cartValJson.success && cartValJson.validation) {
            setResolvedPrice({
              hasConfiguredPrice: cartValJson.validation.price.hasConfiguredPrice,
              monthlyPriceFormatted: cartValJson.validation.price.monthlyPriceFormatted,
              currency: cartValJson.validation.price.currency,
            });
          } else {
            setResolvedPrice({
              hasConfiguredPrice: false,
              monthlyPriceFormatted: null,
              currency: 'USD',
            });
          }
        }
      } catch (err) {
        if (currentReqId !== preCheckReqIdRef.current) return;
        console.error('[Marketplace] Error evaluating pre-check & pricing:', err);
        setResolvedPrice({
          hasConfiguredPrice: false,
          monthlyPriceFormatted: null,
          currency: 'USD',
        });
        setPreCheckResult({
          status: 'error',
          regulationId: null,
          countryCode: num.countryCode,
          numberType: num.numberType,
          endUserType: userType,
          addressRequirement: null,
          endUserRequirements: [],
          supportingDocumentRequirements: [],
          bundleRequired: false,
          message: 'Error looking up verification requirements. Click to retry.',
        });
      } finally {
        if (currentReqId === preCheckReqIdRef.current) {
          setIsEvaluatingPreCheck(false);
          setIsResolvingPrice(false);
        }
      }
    },
    []
  );

  const handleOpenNumberModal = (num: InventoryNumberItem) => {
    preCheckCacheRef.current = {}; // Reset cache when selecting a new number
    setSelectedNumber(num);
    setCartFeedback(null);
    evaluatePreCheckAndPrice(num, endUserType);
  };

  const handleEndUserTypeChange = (newType: 'business' | 'individual') => {
    setEndUserType(newType);
    if (selectedNumber) {
      evaluatePreCheckAndPrice(selectedNumber, newType);
    }
  };

  // Add Item to Temporary Cart
  const handleAddToCart = async () => {
    if (!selectedNumber) return;
    setIsAddingToCart(true);
    setCartFeedback(null);

    try {
      const res = await fetch('/api/number-marketplace/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidate: {
            phoneNumber: selectedNumber.phoneNumber,
            countryCode: selectedNumber.countryCode,
            numberType: selectedNumber.numberType,
            friendlyDisplay: selectedNumber.friendlyDisplay,
            endUserType,
            locality: selectedNumber.locality,
            region: selectedNumber.region,
            capabilities: selectedNumber.capabilities,
          },
        }),
      });

      const json = await res.json();
      if (res.ok && json.success && json.validation) {
        const val = json.validation;
        const newItem: CartItem = {
          id: `${selectedNumber.phoneNumber}_${endUserType}_${Date.now()}`,
          phoneNumber: selectedNumber.phoneNumber,
          friendlyDisplay: selectedNumber.friendlyDisplay,
          countryCode: selectedNumber.countryCode,
          numberType: selectedNumber.numberType,
          endUserType,
          locality: selectedNumber.locality,
          region: selectedNumber.region,
          capabilities: selectedNumber.capabilities,
          priceFormatted: val.price.monthlyPriceFormatted,
          hasConfiguredPrice: val.price.hasConfiguredPrice,
          preCheckStatus: val.preCheck.status,
          bundleRequired: val.preCheck.bundleRequired,
        };

        setCart((prev) => [...prev.filter((i) => i.phoneNumber !== newItem.phoneNumber), newItem]);
        setSelectedNumber(null);
        setIsCartOpen(true);

        // Automatically trigger purchase readiness evaluation in the background!
        handleCheckReadiness(newItem);
      } else {
        setCartFeedback(json.error || 'Failed to add number to cart.');
      }
    } catch (err) {
      console.error('[Marketplace] Error adding to cart:', err);
      setCartFeedback('Network error adding candidate to cart.');
    } finally {
      setIsAddingToCart(false);
    }
  };

  // Readiness Check State
  const [checkingReadinessId, setCheckingReadinessId] = useState<string | null>(null);

  const handleCheckReadiness = async (item: CartItem) => {
    setCheckingReadinessId(item.id);
    try {
      const res = await fetch('/api/number-marketplace/purchase-readiness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: item.phoneNumber,
          countryCode: item.countryCode,
          numberType: item.numberType,
          endUserType: item.endUserType,
        }),
      });

      const json = await res.json();
      const r = json.readiness || json;

      if (res.ok && json.success && r && r.readinessState) {
        setCart((prev) =>
          prev.map((c) => {
            if (c.id !== item.id) return c;
            return {
              ...c,
              readinessState: r.readinessState,
              readinessMessage: r.customerMessage,
              nextAction: r.nextAction,
              priceChanged: r.priceChanged,
              priceFormatted: r.currentRetailPrice?.monthlyPriceFormatted || r.retailPrice?.monthlyPriceFormatted || c.priceFormatted,
            };
          })
        );
      } else {
        setCart((prev) =>
          prev.map((c) =>
            c.id === item.id
              ? {
                  ...c,
                  readinessState: 'error',
                  readinessMessage: json.error || r.customerMessage || "We couldn't verify this number right now. Please try again.",
                  nextAction: 'unavailable',
                }
              : c
          )
        );
      }
    } catch (err) {
      console.error('[Marketplace] Error checking purchase readiness:', err);
      setCart((prev) =>
        prev.map((c) =>
          c.id === item.id
            ? {
                ...c,
                readinessState: 'error',
                readinessMessage: "We couldn't verify this number right now. Please try again.",
                nextAction: 'unavailable',
              }
            : c
        )
      );
    } finally {
      setCheckingReadinessId(null);
    }
  };

  const handleRemoveFromCart = (id: string) => {
    setCart((prev) => prev.filter((item) => item.id !== id));
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-16 relative">
      {/* Top Navigation & Cart Drawer Toggle */}
      <div className="flex items-center justify-between">
        <Link
          href="/numbers"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to My Numbers</span>
        </Link>

        {/* Temporary Cart Floating Pill */}
        <button
          onClick={() => setIsCartOpen(true)}
          className="relative inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-sm transition-all"
        >
          <ShoppingBag className="w-4 h-4" />
          <span>Cart</span>
          {cart.length > 0 && (
            <span className="w-5 h-5 rounded-full bg-white text-blue-600 text-[11px] font-extrabold flex items-center justify-center">
              {cart.length}
            </span>
          )}
        </button>
      </div>

      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              Number Marketplace
            </h1>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              Browse Available Numbers
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Search live available business phone numbers, review monthly pricing, and check registration requirements.
          </p>
        </div>

        {/* Entitlement Awareness Badge */}
        {entitlements && (
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 flex items-center gap-3 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold text-xs">
              {entitlements.currentActive}
            </div>
            <div className="text-xs">
              <span className="text-slate-500 block text-[11px]">Active Workspace Lines</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {entitlements.currentActive}{' '}
                {entitlements.maxActive !== null ? `/ ${entitlements.maxActive} Allowed` : 'Active'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* FILTER CONTROLS CARD */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
          <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Sliders className="w-4 h-4 text-blue-500" />
            <span>Search & Country Filters</span>
          </span>
        </div>

        {/* ROW 1: Country & Number Type Selectors */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-slate-400" />
              <span>Select Country</span>
            </label>
            {isLoadingCountries ? (
              <div className="h-9 rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" />
            ) : countries.length === 0 ? (
              <div className="p-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 rounded-lg">
                Number inventory is temporarily unavailable. Please try again.
              </div>
            ) : (
              <select
                value={selectedCountry}
                onChange={(e) => setSelectedCountry(e.target.value)}
                className="w-full h-9 px-3 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {countries.map((c) => (
                  <option key={c.countryCode} value={c.countryCode}>
                    {c.countryName} ({c.countryCode})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-slate-400" />
              <span>Number Category</span>
            </label>
            <div className="flex items-center gap-2">
              {['local', 'mobile', 'toll_free'].map((type) => {
                const category = type as 'local' | 'mobile' | 'toll_free';
                const isSupported = supportedNumberTypes.includes(category);
                const isSelected = selectedType === category;

                return (
                  <button
                    key={type}
                    disabled={!isSupported}
                    onClick={() => isSupported && setSelectedType(category)}
                    className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-medium capitalize transition-all border ${
                      isSelected
                        ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                        : isSupported
                        ? 'bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
                        : 'bg-slate-100 dark:bg-slate-950 text-slate-400 border-slate-200 dark:border-slate-900 cursor-not-allowed opacity-50'
                    }`}
                  >
                    {type.replace('_', '-')}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ROW 2: Dynamic Applicable Inputs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-slate-100 dark:border-slate-800/80">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-slate-500">Digit Search (Contains)</label>
            <input
              type="text"
              placeholder="e.g. 555 or 789"
              value={containsInput}
              onChange={(e) => setContainsInput(e.target.value)}
              className="w-full h-8 px-2.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>

          {filterCapabilities.areaCode && (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-500">Area Code</label>
              <input
                type="text"
                placeholder="e.g. 212"
                value={areaCodeInput}
                onChange={(e) => setAreaCodeInput(e.target.value)}
                className="w-full h-8 px-2.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
          )}

          {filterCapabilities.locality && (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-500">City / Locality</label>
              <input
                type="text"
                placeholder="e.g. New York"
                value={localityInput}
                onChange={(e) => setLocalityInput(e.target.value)}
                className="w-full h-8 px-2.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
          )}

          {filterCapabilities.region && (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-500">State / Region</label>
              <input
                type="text"
                placeholder="e.g. NY or NSW"
                value={regionInput}
                onChange={(e) => setRegionInput(e.target.value)}
                className="w-full h-8 px-2.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
          )}

          {filterCapabilities.postalCode && (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-500">Postal Code</label>
              <input
                type="text"
                placeholder="e.g. 10001"
                value={postalCodeInput}
                onChange={(e) => setPostalCodeInput(e.target.value)}
                className="w-full h-8 px-2.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
          )}
        </div>

        {/* ROW 3: Capability Toggles & Submit Button */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t border-slate-100 dark:border-slate-800/80">
          <div className="flex items-center gap-4 text-xs font-medium text-slate-600 dark:text-slate-400">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={voiceOnly}
                onChange={(e) => setVoiceOnly(e.target.checked)}
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span>Voice</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={smsOnly}
                onChange={(e) => setSmsOnly(e.target.checked)}
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span>SMS</span>
            </label>
            {filterCapabilities.mmsCapabilities && (
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={mmsOnly}
                  onChange={(e) => setMmsOnly(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span>MMS</span>
              </label>
            )}
          </div>

          <Button
            onClick={() => performSearch()}
            disabled={isSearching}
            className="text-xs px-4 h-9 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg flex items-center gap-2"
          >
            {isSearching ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Search className="w-3.5 h-3.5" />
            )}
            <span>Search Inventory</span>
          </Button>
        </div>
      </Card>

      {/* RESULTS LIST SECTION */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <span>Available Numbers</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
              Showing {numbers.length} {numbers.length === 1 ? 'Number' : 'Numbers'}
            </span>
          </h2>
        </div>

        {isSearching ? (
          <div className="flex flex-col items-center justify-center py-16 space-y-3 max-w-md mx-auto">
            <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
              Searching live inventory for {selectedCountry} ({selectedType})...
            </p>
          </div>
        ) : searchError ? (
          <Card className="border-rose-200 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-950/20">
            <div className="flex items-start gap-3 p-4">
              <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-sm font-semibold text-rose-900 dark:text-rose-200">
                  Inventory Search Failed
                </h4>
                <p className="text-xs text-rose-700 dark:text-rose-300 mt-1">{searchError}</p>
                <Button
                  onClick={() => performSearch()}
                  variant="outline"
                  className="mt-3 text-xs border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-200"
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                  Retry Search
                </Button>
              </div>
            </div>
          </Card>
        ) : numbers.length === 0 ? (
          <Card className="p-12 text-center space-y-3">
            <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
              <Search className="w-6 h-6 text-slate-400" />
            </div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              No numbers matched your search criteria
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
              Try broadening your filters, removing area code/city restrictions, or selecting another number category.
            </p>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {numbers.map((num) => {
                const locationParts = [num.locality, num.region, num.countryCode].filter(Boolean);
                const locationStr = locationParts.join(', ');
                const reqAddress = num.addressRequirements && num.addressRequirements !== 'none';

                return (
                  <Card
                    key={num.phoneNumber}
                    className="p-4 flex flex-col justify-between space-y-3 border-slate-200/80 dark:border-slate-800/80 hover:border-blue-500/50 dark:hover:border-blue-500/50 transition-all"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-base font-bold text-slate-900 dark:text-slate-100 tracking-tight">
                            {num.friendlyDisplay || num.phoneNumber}
                          </span>
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                            {num.numberType.replace('_', ' ')}
                          </span>
                        </div>
                        {locationStr && (
                          <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 mt-1">
                            <MapPin className="w-3 h-3 shrink-0 text-slate-400" />
                            <span>{locationStr}</span>
                          </div>
                        )}
                      </div>

                      {reqAddress && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60 shrink-0">
                          Address Req.
                        </span>
                      )}
                    </div>

                    {/* Capabilities Indicators & Select Action */}
                    <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800/80">
                      <div className="flex items-center gap-3 text-xs font-medium text-slate-600 dark:text-slate-400">
                        <span
                          className={`flex items-center gap-1 ${
                            num.capabilities.voice
                              ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                              : 'text-slate-400 line-through'
                          }`}
                        >
                          <Phone className="w-3 h-3" /> Voice
                        </span>
                        <span
                          className={`flex items-center gap-1 ${
                            num.capabilities.sms
                              ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                              : 'text-slate-400 line-through'
                          }`}
                        >
                          <MessageSquare className="w-3 h-3" /> SMS
                        </span>
                        <span
                          className={`flex items-center gap-1 ${
                            num.capabilities.mms
                              ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                              : 'text-slate-400 opacity-60'
                          }`}
                        >
                          <Volume2 className="w-3 h-3" /> MMS
                        </span>
                      </div>

                      <Button
                        size="sm"
                        onClick={() => handleOpenNumberModal(num)}
                        className="text-xs px-3 h-7 bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-1.5"
                      >
                        <span>View Details</span>
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>

            {hasMore && (
              <div className="pt-4 text-center">
                <Button
                  onClick={handleLoadMore}
                  disabled={isLoadingMore || isSearching}
                  variant="outline"
                  className="text-xs px-6 py-2 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg inline-flex items-center gap-2"
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
                      <span>Loading more numbers...</span>
                    </>
                  ) : (
                    <span>Load More Numbers</span>
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* NUMBER DETAILS MODAL */}
      {selectedNumber && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-xl animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-start justify-between">
              <div>
                <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider block mb-1">
                  NUMBER DETAILS
                </span>
                <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100">
                  {selectedNumber.friendlyDisplay || selectedNumber.phoneNumber}
                </h3>
              </div>
              <button
                onClick={() => setSelectedNumber(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {/* End-User Registration Type Selection */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-slate-900 dark:text-slate-100 block">
                  Registration Type
                </label>
                <details className="text-[11px] text-blue-600 dark:text-blue-400 cursor-pointer font-medium">
                  <summary className="hover:underline">Which should I choose?</summary>
                  <div className="mt-2 p-2.5 rounded-lg bg-blue-50/70 dark:bg-blue-950/40 border border-blue-200/60 dark:border-blue-900/60 text-[11px] text-slate-700 dark:text-slate-300 space-y-1.5">
                    <div>
                      <strong className="text-blue-900 dark:text-blue-200 block font-semibold">Individual:</strong>
                      For example, you're purchasing a number for your own personal use.
                    </div>
                    <div>
                      <strong className="text-blue-900 dark:text-blue-200 block font-semibold">Business:</strong>
                      For example, you're purchasing a number for your company, team, customer support, sales, or other business operations.
                    </div>
                  </div>
                </details>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => handleEndUserTypeChange('business')}
                  className={`p-3 rounded-xl text-left border transition-all flex flex-col justify-between ${
                    endUserType === 'business'
                      ? 'bg-blue-50/80 dark:bg-blue-950/60 border-blue-500 ring-1 ring-blue-500'
                      : 'bg-slate-50 dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-xs text-slate-900 dark:text-slate-100 mb-1">
                    <Building2 className={`w-4 h-4 ${endUserType === 'business' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`} />
                    <span>Business</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                    Choose this if the phone number will be registered to and used by a company or organization.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => handleEndUserTypeChange('individual')}
                  className={`p-3 rounded-xl text-left border transition-all flex flex-col justify-between ${
                    endUserType === 'individual'
                      ? 'bg-blue-50/80 dark:bg-blue-950/60 border-blue-500 ring-1 ring-blue-500'
                      : 'bg-slate-50 dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-xs text-slate-900 dark:text-slate-100 mb-1">
                    <User className={`w-4 h-4 ${endUserType === 'individual' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`} />
                    <span>Individual</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                    Choose this if the phone number will be registered to and used by you personally.
                  </p>
                </button>
              </div>
            </div>

            {/* Monthly Price Widget */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-1">
              <span className="text-[11px] font-semibold text-slate-500 block uppercase tracking-wider">
                MONTHLY PRICE
              </span>
              {isResolvingPrice ? (
                <div className="h-6 w-32 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
              ) : resolvedPrice?.hasConfiguredPrice ? (
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-extrabold text-slate-900 dark:text-slate-100">
                    {resolvedPrice.monthlyPriceFormatted}
                  </span>
                  <span className="text-xs text-slate-500">/ month</span>
                </div>
              ) : (
                <div className="text-sm font-bold text-amber-600 dark:text-amber-400">
                  Pricing unavailable
                </div>
              )}
              <span className="text-[10px] text-slate-400 block pt-1">
                Recurring monthly subscription fee for this phone line.
              </span>
            </div>

            {/* Verification Requirements Widget (Simplified Pre-Cart Disclosure) */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-blue-500" />
                  <span>Verification Requirements</span>
                </span>
                {/* Simplified Status Pill */}
                {isEvaluatingPreCheck ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>Checking...</span>
                  </span>
                ) : preCheckResult?.status === 'no_additional_requirements' && !preCheckResult?.bundleRequired ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                    No additional verification required
                  </span>
                ) : preCheckResult?.status === 'requirements_found' || preCheckResult?.bundleRequired ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
                    Verification required
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-50 dark:bg-rose-950 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800">
                    Requirements unavailable
                  </span>
                )}
              </div>

              {/* Simple High-Level Disclosure (NO detailed field/doc list pre-cart) */}
              <div className="text-xs">
                {isEvaluatingPreCheck ? (
                  <p className="text-slate-500 text-[11px]">Checking regulatory requirement requirements for this category...</p>
                ) : preCheckResult?.status === 'no_additional_requirements' && !preCheckResult?.bundleRequired ? (
                  <p className="text-emerald-800 dark:text-emerald-300 text-[11px] font-medium">
                    No additional verification is required to register this number.
                  </p>
                ) : preCheckResult?.status === 'requirements_found' || preCheckResult?.bundleRequired ? (
                  <div className="space-y-1">
                    <p className="text-amber-800 dark:text-amber-300 text-[11px] font-medium">
                      Additional verification is required to activate this number.
                    </p>
                    <p className="text-slate-500 text-[11px]">
                      We'll guide you through the required information and documents after you add the number to your cart.
                    </p>
                  </div>
                ) : (
                  <p className="text-rose-700 dark:text-rose-300 text-[11px] font-medium">
                    Verification requirements are temporarily unavailable.
                  </p>
                )}
              </div>
            </div>

            {/* Customer Information Notice */}
            <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-[11px] text-amber-800 dark:text-amber-300 space-y-1">
              <span className="font-bold block">Notice</span>
              <p>
                Adding this number to your cart does not reserve it. Availability will be checked again before purchase.
              </p>
            </div>

            {cartFeedback && (
              <div className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
                {cartFeedback}
              </div>
            )}

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="outline"
                onClick={() => setSelectedNumber(null)}
                className="text-xs px-4"
              >
                Cancel
              </Button>
              <Button
                onClick={handleAddToCart}
                disabled={isAddingToCart || isEvaluatingPreCheck || !resolvedPrice?.hasConfiguredPrice || preCheckResult?.status === 'unavailable' || preCheckResult?.status === 'error'}
                className="text-xs px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-1.5"
              >
                {isAddingToCart ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShoppingBag className="w-3.5 h-3.5" />
                )}
                <span>Add to Cart</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* CART DRAWER */}
      {isCartOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-end">
          <div className="bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 w-full max-w-md h-full flex flex-col justify-between p-6 shadow-2xl animate-in slide-in-from-right duration-200">
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <ShoppingBag className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                    Your Cart
                  </h3>
                </div>
                <button
                  onClick={() => setIsCartOpen(false)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>

              {cart.length === 0 ? (
                <div className="text-center py-12 space-y-2">
                  <ShoppingBag className="w-10 h-10 text-slate-300 dark:text-slate-700 mx-auto" />
                  <p className="text-xs text-slate-500 font-medium">Your cart is currently empty.</p>
                </div>
              ) : (
                <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
                  {cart.map((item) => {
                    const isChecking = checkingReadinessId === item.id;
                    const isReady = item.readinessState === 'ready_for_next_step';
                    const isVerificationReq = item.readinessState === 'verification_required';

                    return (
                      <div
                        key={item.id}
                        className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 space-y-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                                {item.friendlyDisplay || item.phoneNumber}
                              </span>
                              <span className="text-[10px] font-bold uppercase px-1.5 py-0.2 rounded bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                                {item.numberType.replace('_', ' ')}
                              </span>
                            </div>
                            <div className="text-xs text-slate-500">
                              Country: <span className="font-semibold text-slate-700 dark:text-slate-300">{item.countryCode}</span> | Type:{' '}
                              <span className="font-semibold text-slate-700 dark:text-slate-300 capitalize">{item.endUserType}</span>
                            </div>
                            <div className="text-xs pt-1 flex items-center gap-2">
                              <span className="font-bold text-slate-900 dark:text-slate-100">
                                {item.priceFormatted || 'Pricing unavailable'}
                              </span>
                            </div>
                          </div>

                          <button
                            onClick={() => handleRemoveFromCart(item.id)}
                            className="text-slate-400 hover:text-rose-600 p-1 shrink-0"
                            title="Remove item"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        {/* Price Change Banner */}
                        {item.priceChanged && (
                          <div className="p-2 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-[11px] text-amber-800 dark:text-amber-300">
                            Retail price updated to {item.priceFormatted}/month. Please review before proceeding.
                          </div>
                        )}

                        {/* Automatic Readiness Loading or Result Message */}
                        {isChecking ? (
                          <div className="p-2.5 rounded-lg text-xs font-medium border bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300 flex items-center gap-2">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />
                            <span>Checking availability and requirements...</span>
                          </div>
                        ) : item.readinessState ? (
                          <div
                            className={`p-2.5 rounded-lg text-xs font-medium border ${
                              isReady
                                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                                : isVerificationReq
                                ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
                                : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300'
                            }`}
                          >
                            <div className="font-bold text-[11px] uppercase tracking-wider mb-0.5">
                              {isReady
                                ? 'Verification Complete'
                                : isVerificationReq
                                ? 'Verification Required'
                                : 'Purchase Blocked'}
                            </div>
                            <p className="text-[11px]">
                              {isVerificationReq
                                ? 'Additional verification is required before this number can be activated.'
                                : item.readinessMessage}
                            </p>
                          </div>
                        ) : null}

                        {/* Readiness Action Buttons */}
                        <div className="pt-1">
                          {isChecking ? (
                            <Button
                              disabled
                              size="sm"
                              className="w-full text-xs h-8 bg-slate-200 text-slate-500 font-semibold cursor-not-allowed"
                            >
                              Evaluating requirements...
                            </Button>
                          ) : isVerificationReq ? (
                            <div className="space-y-1.5">
                              <Link
                                href={`/numbers/verification?country=${item.countryCode}&type=${item.numberType}&endUserType=${item.endUserType}&phoneNumber=${encodeURIComponent(
                                  item.phoneNumber
                                )}`}
                                className="w-full"
                              >
                                <Button
                                  size="sm"
                                  className="w-full text-xs h-8 bg-amber-600 hover:bg-amber-700 text-white font-semibold flex items-center justify-center gap-1.5"
                                >
                                  <span>Continue to Verification</span>
                                </Button>
                              </Link>
                              <span className="text-[10px] text-slate-400 block text-center">
                                Complete required business information and identity documents.
                              </span>
                            </div>
                          ) : isReady ? (
                            <div className="space-y-1.5">
                              <Button
                                onClick={() => handleOpenCheckoutModal(item)}
                                disabled={purchasingItemId === item.id || !canManage}
                                size="sm"
                                className="w-full text-xs h-8 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold flex items-center justify-center gap-1.5 shadow-sm"
                              >
                                {purchasingItemId === item.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <ShoppingBag className="w-3.5 h-3.5" />
                                )}
                                <span>Authorize Payment (Checkout)</span>
                              </Button>
                              <span className="text-[10px] text-slate-400 block text-center">
                                {!canManage
                                  ? 'Only Organization Owners and Admins can authorize payments.'
                                  : 'Click to open secure Stripe Payment Element.'}
                              </span>
                            </div>
                          ) : (
                            <Button
                              onClick={() => handleCheckReadiness(item)}
                              size="sm"
                              className="w-full text-xs h-8 bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center justify-center gap-1.5"
                            >
                              <span>Re-check Purchase Readiness</span>
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Cart Footer Notice */}
            <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800">
              {cartFeedback && (
                <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 space-y-1">
                  <span className="font-bold block">Checkout Information</span>
                  <p>{cartFeedback}</p>
                </div>
              )}

              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-[11px] text-amber-800 dark:text-amber-300 space-y-1">
                <span className="font-bold block">Notice</span>
                <p>
                  Cart items are not reserved. Final confirmation of availability and compliance will be performed at checkout.
                </p>
              </div>

              <div className="flex justify-end">
                <Button
                  onClick={() => setIsCartOpen(false)}
                  className="w-full text-xs h-9 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold rounded-lg"
                >
                  Close Cart
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ACTIVE PURCHASE OPERATION STATUS MODAL */}
      {activeOperation && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Purchase Status
              </h3>
              <button
                onClick={() => setActiveOperation(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <div className="text-center py-4 space-y-3">
              {!activeOperation.isTerminal ? (
                <div className="w-12 h-12 mx-auto rounded-full bg-blue-50 dark:bg-blue-950 flex items-center justify-center">
                  <Loader2 className="w-6 h-6 text-blue-600 dark:text-blue-400 animate-spin" />
                </div>
              ) : activeOperation.status === 'succeeded' ? (
                <div className="w-12 h-12 mx-auto rounded-full bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center">
                  <Phone className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
                </div>
              ) : activeOperation.status === 'authorized' ? (
                <div className="w-12 h-12 mx-auto rounded-full bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center">
                  <CheckCircle className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
                </div>
              ) : (
                <div className="w-12 h-12 mx-auto rounded-full bg-rose-50 dark:bg-rose-950 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-rose-600 dark:text-rose-400" />
                </div>
              )}

              <div className="space-y-1">
                <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  {activeOperation.customerStatusWording}
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {activeOperation.status === 'succeeded'
                    ? 'Your number has been successfully assigned and activated for your workspace.'
                    : activeOperation.status === 'authorized'
                    ? 'Payment authorization successful. Your payment has not been captured yet. Number activation will begin only after checkout processing continues.'
                    : activeOperation.status === 'failed'
                    ? 'We were unable to complete the activation for this number.'
                    : 'Our system is processing your request. You may close this window.'}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
              {activeOperation.status === 'succeeded' ? (
                <Link href="/numbers" className="w-full">
                  <Button className="w-full text-xs h-9 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg flex items-center justify-center gap-1.5">
                    <span>View in My Numbers</span>
                  </Button>
                </Link>
              ) : (
                <Button
                  onClick={() => setActiveOperation(null)}
                  className="w-full text-xs h-9 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold rounded-lg"
                >
                  Close
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Stripe Payment Element Modal (Phase 13.2) */}
      <StripePaymentElementModal
        isOpen={isCheckoutModalOpen}
        onClose={() => setIsCheckoutModalOpen(false)}
        selection={checkoutSelection}
        onPaymentSuccess={(opId) => {
          setIsCartOpen(false);
          setActiveOperation({
            id: opId,
            status: 'authorized',
            customerStatusWording: 'Payment Authorized',
            isTerminal: true,
          });
        }}
      />
    </div>
  );
}
