/**
 * VoIP Hub Chrome Extension - CRM-Native Content Script
 * Authoritative Zoho CRM Record Context & Phone Value Extractor with In-Page Floating Dialer.
 */

import { SERVER_BASE } from './config';

declare const chrome: any;

const SVG_ICONS = {
  PHONE: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  MUTE: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,
  UNMUTE: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,
  KEYPAD: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="4" height="4" rx="1"></rect><rect x="10" y="3" width="4" height="4" rx="1"></rect><rect x="17" y="3" width="4" height="4" rx="1"></rect><rect x="3" y="10" width="4" height="4" rx="1"></rect><rect x="10" y="10" width="4" height="4" rx="1"></rect><rect x="17" y="10" width="4" height="4" rx="1"></rect><rect x="3" y="17" width="4" height="4" rx="1"></rect><rect x="10" y="17" width="4" height="4" rx="1"></rect><rect x="17" y="17" width="4" height="4" rx="1"></rect></svg>`,
  END_CALL: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path><line x1="23" y1="1" x2="1" y2="23"></line></svg>`,
  RECORD: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="red" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle></svg>`,
  MINIMIZE: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  CLOSE: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
};

export interface DetectedPhoneNumber {
  label: string;
  value: string;
}

export interface CrmContext {
  recordName: string;
  phoneNumbers: DetectedPhoneNumber[];
}

let currentCrmContext: CrmContext = {
  recordName: 'Zoho CRM Record',
  phoneNumbers: [],
};

let activePhone = '';
let activeName = '';
let isPanelCollapsed = false;
let activeCallState: any = null;

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Normalizes multi-line or split phone text from DOM nodes.
 * E.g. "+9812\n34902\n3" -> "+9812349023"
 */
function cleanAndNormalizePhoneText(rawText: string): { normalized: string; isPhone: boolean } {
  if (!rawText) return { normalized: '', isPhone: false };

  const collapsed = rawText.replace(/[\r\n\t]+/g, ' ').trim();
  const digitsOnly = collapsed.replace(/[^\d+]/g, '');

  const numDigits = digitsOnly.replace(/\D/g, '').length;
  if (numDigits < 7 || numDigits > 15) {
    return { normalized: '', isPhone: false };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(collapsed) || /^\$\d+/.test(collapsed)) {
    return { normalized: '', isPhone: false };
  }

  return { normalized: digitsOnly, isPhone: true };
}

/**
 * Robust Record Name Extractor for Zoho CRM
 */
function extractRecordName(): string {
  const selectors = [
    '#headTitle',
    '[data-zcqa="entity_name"]',
    '.detailViewHead',
    '#crmEntityTitle',
    '.lyteTitle',
    '.recordTitle',
    'h1',
  ];

  for (const sel of selectors) {
    const elem = document.querySelector(sel);
    const text = elem?.textContent?.trim();
    if (text && text.length > 1 && !text.toLowerCase().includes('zoho crm')) {
      return text;
    }
  }

  const pageTitle = document.title || '';
  if (pageTitle.includes('-')) {
    const namePart = pageTitle.split('-')[0].trim();
    if (namePart && !namePart.toLowerCase().includes('zoho')) {
      return namePart;
    }
  }

  return 'Zoho CRM Record';
}

/**
 * Authoritative DOM Scanner for Zoho Phone Fields
 */
function scanZohoRecordFields(): CrmContext {
  const detectedList: DetectedPhoneNumber[] = [];
  const seenValues = new Set<string>();

  // 1. Scan tel: links
  const telLinks = document.querySelectorAll<HTMLAnchorElement>('a[href^="tel:"]');
  telLinks.forEach((link) => {
    if (link.closest('#voiphub-crm-floating-panel')) return;
    const hrefAttr = link.getAttribute('href') || '';
    const rawVal = hrefAttr.replace('tel:', '').trim() || link.textContent || '';
    const { normalized, isPhone } = cleanAndNormalizePhoneText(rawVal);

    if (isPhone && !seenValues.has(normalized)) {
      seenValues.add(normalized);
      detectedList.push({ label: 'Phone', value: normalized });

      if (!link.hasAttribute('data-voiphub-injected')) {
        link.setAttribute('data-voiphub-injected', 'true');
        injectCrmCallButton(link, normalized, 'Phone');
      }
    }
  });

  // 2. Label/Value DOM inspection
  const phoneLabelRegex = /(phone|mobile|tel|cell|contact number|work phone|home phone|business phone|fax)/i;
  const allElements = Array.from(document.querySelectorAll('*'));

  for (const elem of allElements) {
    if (elem.closest('#voiphub-crm-floating-panel')) continue;
    if (elem.children.length > 4) continue;
    const text = elem.textContent?.trim() || '';

    if (text && text.length < 35 && phoneLabelRegex.test(text)) {
      let rawLabel = text.replace(/[:\-]$/, '').trim();

      let valElem = elem.nextElementSibling as HTMLElement | null;
      if (!valElem && elem.parentElement) {
        valElem = elem.parentElement.nextElementSibling as HTMLElement | null;
      }
      if (!valElem) {
        valElem = elem.querySelector('.crm-fld-val, .fieldValue, [class*="val"], [class*="Val"], span, td') as HTMLElement | null;
      }

      if (valElem) {
        if (valElem.closest('#voiphub-crm-floating-panel')) continue;
        const clone = valElem.cloneNode(true) as HTMLElement;
        const injectedBtn = clone.querySelector('.voiphub-c2c-btn');
        if (injectedBtn) injectedBtn.remove();

        const rawVal = clone.innerText || clone.textContent || '';
        const { normalized, isPhone } = cleanAndNormalizePhoneText(rawVal);

        if (isPhone && !seenValues.has(normalized)) {
          seenValues.add(normalized);
          detectedList.push({ label: rawLabel, value: normalized });

          if (!valElem.hasAttribute('data-voiphub-injected')) {
            valElem.setAttribute('data-voiphub-injected', 'true');
            injectCrmCallButton(valElem, normalized, rawLabel);
          }
        }
      }
    }
  }

  // 3. Attribute/ID selectors
  const attrSelectors = [
    '[data-field*="Phone"]',
    '[data-field*="phone"]',
    '[data-field*="Mobile"]',
    '[data-field*="mobile"]',
    '[id*="phone"]',
    '[id*="Phone"]',
    '[id*="mobile"]',
    '[id*="Mobile"]',
    '.zc-phone',
    '.crm-phone',
  ];

  const attrElems = document.querySelectorAll(attrSelectors.join(','));
  attrElems.forEach((elem) => {
    if (elem.closest('#voiphub-crm-floating-panel')) return;
    if (elem.tagName === 'INPUT' || elem.tagName === 'TEXTAREA' || (elem as HTMLElement).isContentEditable) return;
    
    const clone = elem.cloneNode(true) as HTMLElement;
    const injectedBtn = clone.querySelector('.voiphub-c2c-btn');
    if (injectedBtn) injectedBtn.remove();

    const rawVal = clone.innerText || clone.textContent || '';
    const { normalized, isPhone } = cleanAndNormalizePhoneText(rawVal);

    if (isPhone && !seenValues.has(normalized)) {
      seenValues.add(normalized);
      const labelAttr = elem.getAttribute('data-field') || (elem.id && elem.id.toLowerCase().includes('mobile') ? 'Mobile' : 'Phone');
      detectedList.push({ label: labelAttr, value: normalized });

      if (!elem.hasAttribute('data-voiphub-injected')) {
        elem.setAttribute('data-voiphub-injected', 'true');
        injectCrmCallButton(elem as HTMLElement, normalized, labelAttr);
      }
    }
  });

  const recordName = extractRecordName();
  return {
    recordName,
    phoneNumbers: detectedList,
  };
}

/**
 * Injects non-intrusive Call button beside detected Zoho fields
 */
function injectCrmCallButton(targetElem: HTMLElement, phone: string, label: string) {
  if (targetElem.querySelector('.voiphub-c2c-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'voiphub-c2c-btn';
  btn.innerHTML = `${SVG_ICONS.PHONE} Call`;
  btn.title = `Call ${label} (${phone}) with VoIP Hub`;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const recordName = extractRecordName();

    console.log('[VoIP Hub Content] Click-to-call triggered for:', phone, 'Record:', recordName);

    chrome.runtime.sendMessage({
      type: 'INITIATE_CALL_FROM_CRM',
      data: {
        provider: 'zoho',
        recordType: 'Record',
        recordName,
        phoneLabel: label,
        phoneNumber: phone,
      },
    }).catch((err: any) => {
      console.warn('[VoIP Hub Content] Message error:', err);
    });
  });

  if (targetElem.tagName === 'A') {
    targetElem.insertAdjacentElement('afterend', btn);
  } else {
    targetElem.appendChild(btn);
  }
}

function updateCrmContext() {
  currentCrmContext = scanZohoRecordFields();
}

// Respond to GET_CURRENT_CRM_CONTEXT query from background or extension tabs
chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (res?: any) => void) => {
  if (message?.type === 'GET_CURRENT_CRM_CONTEXT') {
    updateCrmContext();
    sendResponse(currentCrmContext);
    return false;
  }
  return false;
});

// Initial scan & MutationObserver for SPA navigation
updateCrmContext();
const observer = new MutationObserver(() => {
  updateCrmContext();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

export {};

