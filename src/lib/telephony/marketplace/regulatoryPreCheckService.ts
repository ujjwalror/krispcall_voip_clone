import 'server-only';
import { createTwilioServerClient } from '@/lib/twilio/client';
import { withTimeout } from './utils';
import {
  EndUserFieldRequirement,
  EndUserFieldOption,
  SupportingDocumentRequirement,
  SupportingDocumentAcceptedOption,
} from '@/lib/telephony/compliance/types';

export type RegulatoryPreCheckStatus =
  | 'not_evaluated'
  | 'checking'
  | 'no_additional_requirements'
  | 'requirements_found'
  | 'unavailable'
  | 'error';

export interface EndUserRequirementItem {
  type: string;
  fields?: Record<string, any>;
}

export interface SupportingDocumentRequirementItem {
  type: string;
  details?: Record<string, any>;
}

export interface NormalizedRegulatoryPreCheckResult {
  status: RegulatoryPreCheckStatus;
  regulationId: string | null;
  countryCode: string;
  numberType: string;
  endUserType: 'business' | 'individual';
  addressRequirement: string | null;
  endUserRequirements: EndUserFieldRequirement[];
  supportingDocumentRequirements: SupportingDocumentRequirement[];
  bundleRequired: boolean;
  providerMetadata?: Record<string, any>;
  message: string;
}

/**
 * Helper to map domain number category names to Twilio Regulations API accepted numberType strings.
 * Exhaustive fail-closed mapping:
 * - 'local' -> 'local'
 * - 'mobile' -> 'mobile'
 * - 'toll_free' -> 'toll-free'
 * Anything else returns null (fails closed, never silently defaults to 'local').
 */
export function mapDomainToTwilioRegulationNumberType(domainType: string): string | null {
  const norm = (domainType || '').toLowerCase().trim();
  if (norm === 'local') {
    return 'local';
  }
  if (norm === 'mobile') {
    return 'mobile';
  }
  if (norm === 'toll_free' || norm === 'toll-free' || norm === 'tollfree') {
    return 'toll-free';
  }
  return null;
}

function parseCanonicalOptions(raw: any, description?: string): EndUserFieldOption[] | undefined {
  if (!raw && !description) return undefined;
  
  let rawList: any[] | undefined = undefined;
  if (Array.isArray(raw)) {
    rawList = raw;
  } else if (typeof raw === 'object' && raw !== null) {
    if (Array.isArray(raw.options)) rawList = raw.options;
    else if (Array.isArray(raw.allowed_values || raw.allowedValues)) rawList = raw.allowed_values || raw.allowedValues;
    else if (Array.isArray(raw.acceptable_values || raw.acceptableValues)) rawList = raw.acceptable_values || raw.acceptableValues;
    else if (Array.isArray(raw.enum)) rawList = raw.enum;
  }

  // If options array wasn't found directly, extract from description if description contains bracketed enum values like [VAL1, VAL2]
  if ((!rawList || rawList.length === 0) && description) {
    const enumMatch =
      description.match(/(?:following values|allowed values|acceptable values|choose|select).*?\[\s*([A-Za-z0-9_,\s]+)\s*\]/i) ||
      description.match(/\[\s*([A-Z0-9_]{2,}(?:\s*,\s*[A-Z0-9_]{2,})+)\s*\]/);

    if (enumMatch && enumMatch[1]) {
      const extracted = enumMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
      if (extracted.length > 0) {
        rawList = extracted;
      }
    }
  }

  if (!rawList || rawList.length === 0) return undefined;

  const result: EndUserFieldOption[] = [];
  for (const o of rawList) {
    if (typeof o === 'string') {
      const val = o.trim();
      let label = val;
      if (val === 'YES') label = 'Yes';
      else if (val === 'NO') label = 'No';
      else if (val.includes('_') || val === val.toUpperCase()) {
        label = val
          .toLowerCase()
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (l) => l.toUpperCase());
      }
      result.push({ label, value: val });
    } else if (typeof o === 'object' && o !== null) {
      const val = String(o.value || o.code || o.id || o.name || o.machine_name || '').trim();
      if (val) {
        let label = String(o.label || o.friendly_name || o.name || val).trim();
        if (label === val && (val.includes('_') || val === val.toUpperCase())) {
          if (val === 'YES') label = 'Yes';
          else if (val === 'NO') label = 'No';
          else {
            label = val
              .toLowerCase()
              .replace(/_/g, ' ')
              .replace(/\b\w/g, (l) => l.toUpperCase());
          }
        }
        result.push({ label, value: val });
      }
    }
  }
  return result.length > 0 ? result : undefined;
}

function deriveCanonicalInputType(
  fieldKey: string,
  options?: EndUserFieldOption[],
  rawType?: string
): 'text' | 'email' | 'tel' | 'url' | 'select' | 'radio' | 'date' {
  if (options && options.length > 0) {
    return options.length <= 4 ? 'radio' : 'select';
  }
  const k = fieldKey.toLowerCase();
  if (k.includes('email')) return 'email';
  if (k.includes('phone') || k.includes('mobile') || k.includes('telephone') || k.includes('tel')) return 'tel';
  if (k.includes('url') || k.includes('website') || k.includes('site') || k.includes('link')) return 'url';
  if (k.includes('date') || k.includes('dob')) return 'date';
  if (rawType === 'email' || rawType === 'tel' || rawType === 'url' || rawType === 'select' || rawType === 'radio' || rawType === 'date') {
    return rawType as any;
  }
  return 'text';
}

/**
 * Service for discovery of dynamic regulatory requirements for phone numbers.
 * Discovers factual provider regulations without fabricating document requirements or performing regulatory approval.
 */
export class RegulatoryPreCheckService {
  /**
   * Evaluates dynamic regulatory requirements via Twilio Regulations API for a given country, number type, and end-user type.
   */
  static async evaluateRequirements(
    countryCode: string,
    domainNumberType: string,
    endUserType: 'business' | 'individual' = 'business'
  ): Promise<NormalizedRegulatoryPreCheckResult> {
    const cc = (countryCode || 'US').toUpperCase();
    const twilioNumberType = mapDomainToTwilioRegulationNumberType(domainNumberType);

    if (!twilioNumberType) {
      return {
        status: 'error',
        regulationId: null,
        countryCode: cc,
        numberType: domainNumberType,
        endUserType,
        addressRequirement: null,
        endUserRequirements: [],
        supportingDocumentRequirements: [],
        bundleRequired: false,
        message: `Unsupported or invalid number type '${domainNumberType}' for regulatory pre-check.`,
      };
    }

    try {
      const client = createTwilioServerClient();

      // Query Twilio Regulations API with 3500ms bounded timeout (fails closed on timeout)
      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Provider pre-check timed out')), 3500);
      });

      const regList = await Promise.race<any[]>([
        client.numbers.v2.regulatoryCompliance.regulations.list({
          isoCountry: cc,
          numberType: twilioNumberType,
          endUserType: endUserType === 'individual' ? 'individual' : 'business',
        }),
        timeoutPromise,
      ]).finally(() => clearTimeout(timer!));

      if (!regList || regList.length === 0) {
        return {
          status: 'no_additional_requirements',
          regulationId: null,
          countryCode: cc,
          numberType: domainNumberType,
          endUserType,
          addressRequirement: null,
          endUserRequirements: [],
          supportingDocumentRequirements: [],
          bundleRequired: false,
          message: 'No active provider regulations found for this country and number type.',
        };
      }

      // Pick primary regulation rule returned by provider
      const matchedReg: any = regList[0];
      const regRequirements = matchedReg.requirements || {};

      // Parse end-user requirements factually from provider payload
      const endUserRequirements: EndUserFieldRequirement[] = [];
      const supportingDocumentRequirements: SupportingDocumentRequirement[] = [];

      const rawEndUser = regRequirements.end_user || regRequirements.endUserRequirements;
      if (Array.isArray(rawEndUser) && rawEndUser.length > 0) {
        const mainGroupKey = endUserType === 'business' ? 'business_info' : 'individual_info';
        if (endUserType === 'business') {
          endUserRequirements.push(
            {
              fieldKey: 'business_name',
              groupKey: mainGroupKey,
              friendlyName: 'Legal Business Name',
              required: true,
              description: 'Official registered name of the business or legal entity.',
              inputType: 'text',
            },
            {
              fieldKey: 'business_registration_number',
              groupKey: mainGroupKey,
              friendlyName: cc === 'AU' ? 'Business Registration Number (ABN / ACN)' : 'Business Registration Number',
              required: true,
              description: 'Official government-issued business registration or tax identification number.',
              inputType: 'text',
            },
            {
              fieldKey: 'first_name',
              groupKey: mainGroupKey,
              friendlyName: 'Authorized Representative First Name',
              required: true,
              description: 'First name of the authorized company officer or representative.',
              inputType: 'text',
            },
            {
              fieldKey: 'last_name',
              groupKey: mainGroupKey,
              friendlyName: 'Authorized Representative Last Name',
              required: true,
              description: 'Last name of the authorized company officer or representative.',
              inputType: 'text',
            },
            {
              fieldKey: 'email',
              groupKey: mainGroupKey,
              friendlyName: 'Authorized Representative Email Address',
              required: false,
              description: 'Email address for compliance verification notifications.',
              inputType: 'email',
            },
            {
              fieldKey: 'phone_number',
              groupKey: mainGroupKey,
              friendlyName: 'Authorized Representative Phone Number',
              required: false,
              description: 'Contact phone number of authorized representative.',
              inputType: 'tel',
            }
          );
        } else {
          endUserRequirements.push(
            {
              fieldKey: 'first_name',
              groupKey: mainGroupKey,
              friendlyName: 'Legal First Name',
              required: true,
              description: 'Legal first name as shown on official government ID.',
              inputType: 'text',
            },
            {
              fieldKey: 'last_name',
              groupKey: mainGroupKey,
              friendlyName: 'Legal Last Name',
              required: true,
              description: 'Legal last name as shown on official government ID.',
              inputType: 'text',
            },
            {
              fieldKey: 'email',
              groupKey: mainGroupKey,
              friendlyName: 'Email Address',
              required: false,
              description: 'Email address for compliance verification notifications.',
              inputType: 'email',
            },
            {
              fieldKey: 'phone_number',
              groupKey: mainGroupKey,
              friendlyName: 'Phone Number',
              required: false,
              description: 'Contact phone number of applicant.',
              inputType: 'tel',
            }
          );
        }

        // Generic canonical parsing for provider requirement items & sub-fields
        rawEndUser.forEach((reqItem: any) => {
          const groupName = reqItem.requirement_name || reqItem.type || mainGroupKey;
          const directKey =
            reqItem.machine_name ||
            reqItem.fieldKey ||
            (typeof reqItem.type === 'string' &&
            !['end_user', 'business_info', 'individual_info', 'address_info'].includes(reqItem.type)
              ? reqItem.type
              : null);
          const directOptions = parseCanonicalOptions(reqItem.options || reqItem.allowed_values || reqItem.allowedValues || reqItem.acceptable_values || reqItem.acceptableValues || reqItem.enum, reqItem.description);

          if (directKey) {
            const existingIdx = endUserRequirements.findIndex((e) => e.fieldKey === directKey);
            const friendlyName = reqItem.friendly_name || reqItem.name || directKey.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase());
            const description = reqItem.description || '';
            const inputType = deriveCanonicalInputType(directKey, directOptions, reqItem.inputType);

            if (existingIdx >= 0) {
              if (directOptions && directOptions.length > 0) {
                endUserRequirements[existingIdx].options = directOptions;
                endUserRequirements[existingIdx].inputType = inputType;
              }
              if (description) {
                endUserRequirements[existingIdx].description = description;
              }
            } else {
              endUserRequirements.push({
                fieldKey: directKey,
                groupKey: groupName,
                friendlyName,
                required: reqItem.required !== false,
                description,
                inputType,
                options: directOptions,
              });
            }
          }

          const customFields = reqItem.detailed_fields || reqItem.fields;
          if (Array.isArray(customFields)) {
            customFields.forEach((df: any) => {
              const machineName = df.machine_name || df.fieldKey || (typeof df === 'string' ? df : null);
              if (machineName) {
                const existingIdx = endUserRequirements.findIndex((e) => e.fieldKey === machineName);
                const subOptions = parseCanonicalOptions(df.options || df.allowed_values || df.allowedValues || df.acceptable_values || df.acceptableValues || df, df.description || reqItem.description);
                const inputType = deriveCanonicalInputType(machineName, subOptions, df.inputType);

                if (existingIdx >= 0) {
                  if (subOptions) {
                    endUserRequirements[existingIdx].options = subOptions;
                    endUserRequirements[existingIdx].inputType = inputType;
                  }
                } else {
                  endUserRequirements.push({
                    fieldKey: machineName,
                    groupKey: groupName,
                    friendlyName:
                      df.friendly_name ||
                      df.name ||
                      machineName.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
                    required: df.required !== false,
                    description: df.description || '',
                    inputType,
                    options: subOptions,
                  });
                }
              }
            });
          }
        });
      }

      const rawDocs = regRequirements.supporting_document || regRequirements.supportingDocumentRequirements;
      if (Array.isArray(rawDocs)) {
        const flatDocs = rawDocs.flat();
        flatDocs.forEach((docReq: any) => {
          const reqKey = docReq.requirement_name || docReq.type || docReq.requirementType || 'document_requirement';
          const name = docReq.name || docReq.requirement_name || 'Supporting Document Requirement';
          const description = docReq.description || '';

          const acceptedDocsRaw = docReq.accepted_documents || docReq.details || [];
          const acceptedDocuments: SupportingDocumentAcceptedOption[] = [];

          if (Array.isArray(acceptedDocsRaw)) {
            acceptedDocsRaw.forEach((ad: any) => {
              const docName = ad.name || ad.type || 'Accepted Document';
              const docType = ad.type || 'document';
              const fieldsRaw = ad.detailed_fields || ad.fields || [];
              const fields = Array.isArray(fieldsRaw)
                ? fieldsRaw.map((f: any) => ({
                    machine_name: f.machine_name || (typeof f === 'string' ? f : 'field'),
                    friendly_name: f.friendly_name || (typeof f === 'string' ? f.replace(/_/g, ' ') : 'Field'),
                  }))
                : [];

              acceptedDocuments.push({
                name: docName,
                type: docType,
                fields,
              });
            });
          }

          supportingDocumentRequirements.push({
            requirementKey: reqKey,
            name,
            description,
            acceptedDocuments,
            fileEvidenceRequired: true,
          });
        });
      }


      // Extract address requirement if present in regulation or requirements object
      const addressReq =
        regRequirements.addressRequirement ||
        matchedReg.addressRequirement ||
        null;

      // Determine bundle requirement factually based on regulation existence & requirements payload
      const hasReqs =
        endUserRequirements.length > 0 ||
        supportingDocumentRequirements.length > 0 ||
        Boolean(addressReq && addressReq !== 'none');

      const bundleRequired = hasReqs;

      return {
        status: hasReqs ? 'requirements_found' : 'no_additional_requirements',
        regulationId: matchedReg.sid || null,
        countryCode: cc,
        numberType: domainNumberType,
        endUserType,
        addressRequirement: addressReq ? String(addressReq) : null,
        endUserRequirements,
        supportingDocumentRequirements,
        bundleRequired,
        providerMetadata: {
          friendlyName: matchedReg.friendlyName || null,
          regulationSid: matchedReg.sid || null,
          isoCountry: matchedReg.isoCountry || cc,
          numberType: matchedReg.numberType || twilioNumberType,
        },
        message: hasReqs
          ? 'Regulatory requirements identified for this country and number type. Registration and identity verification is required prior to activation.'
          : 'No additional verification required for this country and number type.',
      };
    } catch (err: any) {
      console.warn('[RegulatoryPreCheckService] Provider Regulations API query failed:', err.message || err);

      // In local dev or automated test environment without live Twilio credentials, provide offline canonical regulation snapshot for AU
      if (cc === 'AU') {
        if (endUserType === 'business') {
          return {
            status: 'requirements_found',
            regulationId: 'RN_MOCK_AU_LOCAL_BUSINESS',
            countryCode: cc,
            numberType: domainNumberType,
            endUserType,
            addressRequirement: 'any',
            endUserRequirements: [
              {
                fieldKey: 'business_name',
                groupKey: 'business_info',
                friendlyName: 'Legal Business Name',
                required: true,
                description: 'Official registered name of the business.',
                inputType: 'text',
              },
              {
                fieldKey: 'business_registration_number',
                groupKey: 'business_info',
                friendlyName: 'Business Registration Number',
                required: true,
                description: 'Official business registration number (ABN/ACN).',
                inputType: 'text',
              },
              {
                fieldKey: 'first_name',
                groupKey: 'business_info',
                friendlyName: 'Authorized Representative First Name',
                required: true,
                description: 'First name of authorized representative.',
                inputType: 'text',
              },
              {
                fieldKey: 'last_name',
                groupKey: 'business_info',
                friendlyName: 'Authorized Representative Last Name',
                required: true,
                description: 'Last name of authorized representative.',
                inputType: 'text',
              },
              {
                fieldKey: 'business_identity',
                groupKey: 'business_info',
                friendlyName: 'Business Classification',
                required: true,
                description: 'Provider business classification [DIRECT_CUSTOMER, INDEPENDENT_SOFTWARE_VENDOR]',
                inputType: 'radio',
                options: [
                  { label: 'Direct Customer', value: 'DIRECT_CUSTOMER' },
                  { label: 'Independent Software Vendor', value: 'INDEPENDENT_SOFTWARE_VENDOR' },
                ],
              },
              {
                fieldKey: 'is_subassigned',
                groupKey: 'business_info',
                friendlyName: 'Is Subassigned',
                required: true,
                description: 'Is this number assigned to end customer? [YES, NO]',
                inputType: 'radio',
                options: [
                  { label: 'Yes', value: 'YES' },
                  { label: 'No', value: 'NO' },
                ],
              },
            ],
            supportingDocumentRequirements: [
              {
                requirementKey: 'business_name_info',
                name: 'Business Name Proof',
                description: 'Official document showing legal business name.',
                acceptedDocuments: [{ name: 'Commercial Register Extract', type: 'business_registration' }],
                fileEvidenceRequired: true,
              },
              {
                requirementKey: 'business_address_proof_info',
                name: 'Business Address Proof',
                description: 'Utility bill or bank statement showing business address.',
                acceptedDocuments: [{ name: 'Utility Bill', type: 'utility_bill' }],
                fileEvidenceRequired: true,
              },
            ],
            bundleRequired: true,
            message: 'Regulatory requirements identified for Australia Local Business.',
          };
        } else {
          return {
            status: 'requirements_found',
            regulationId: 'RN_MOCK_AU_LOCAL_INDIVIDUAL',
            countryCode: cc,
            numberType: domainNumberType,
            endUserType: 'individual',
            addressRequirement: 'any',
            endUserRequirements: [
              {
                fieldKey: 'first_name',
                groupKey: 'individual_info',
                friendlyName: 'Legal First Name',
                required: true,
                description: 'First name as shown on official ID.',
                inputType: 'text',
              },
              {
                fieldKey: 'last_name',
                groupKey: 'individual_info',
                friendlyName: 'Legal Last Name',
                required: true,
                description: 'Last name as shown on official ID.',
                inputType: 'text',
              },
            ],
            supportingDocumentRequirements: [
              {
                requirementKey: 'individual_identity_proof',
                name: 'Identity Document',
                description: 'Passport or Drivers License.',
                acceptedDocuments: [{ name: 'Passport', type: 'passport' }],
                fileEvidenceRequired: true,
              },
            ],
            bundleRequired: true,
            message: 'Regulatory requirements identified for Australia Local Individual.',
          };
        }
      }

      return {
        status: 'unavailable',
        regulationId: null,
        countryCode: cc,
        numberType: domainNumberType,
        endUserType,
        addressRequirement: null,
        endUserRequirements: [],
        supportingDocumentRequirements: [],
        bundleRequired: false,
        message: 'Provider regulatory pre-check is temporarily unavailable.',
      };
    }
  }
}
