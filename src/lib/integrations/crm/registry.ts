import { CRMAdapter, CRMConnectionSummary, CRMProviderId } from './types';
import { ZohoCRMAdapter } from './adapters/zohoAdapter';

const adapters: Partial<Record<CRMProviderId, CRMAdapter>> = {
  zoho: new ZohoCRMAdapter(),
};

const COMING_SOON_PROVIDERS: CRMConnectionSummary[] = [
  {
    provider: 'hubspot',
    name: 'HubSpot',
    description: 'Inbound marketing, sales CRM, and customer service synchronization.',
    status: 'coming_soon',
    isAvailable: false,
  },
  {
    provider: 'salesforce',
    name: 'Salesforce',
    description: 'Enterprise Cloud CRM contacts, leads, opportunities, and activity logging.',
    status: 'coming_soon',
    isAvailable: false,
  },
  {
    provider: 'pipedrive',
    name: 'Pipedrive',
    description: 'Sales pipeline, deal tracking, and activity synchronization.',
    status: 'coming_soon',
    isAvailable: false,
  },
  {
    provider: 'clickup',
    name: 'ClickUp',
    description: 'Task management and CRM-style workflow integration.',
    status: 'coming_soon',
    isAvailable: false,
  },
];

export function getCRMAdapter(providerId: CRMProviderId): CRMAdapter {
  const adapter = adapters[providerId];
  if (!adapter) {
    throw new Error(`CRM Provider "${providerId}" is not supported or not yet available.`);
  }
  return adapter;
}

export function getComingSoonProviders(): CRMConnectionSummary[] {
  return COMING_SOON_PROVIDERS;
}
