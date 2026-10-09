/**
 * Qonto API – Organization.
 * GET /v2/organization (with optional include_external_accounts).
 */

import { get } from './request.ts';
import type { Organization as OrgType } from './types.ts';

export interface GetOrganizationOptions {
    includeExternalAccounts?: boolean;
}

export interface OrganizationResponse {
    organization: OrgType;
}

/**
 * Get organization and its bank accounts.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function getOrganization(options: GetOrganizationOptions = {}): Promise<OrganizationResponse> {
    const query: Record<string, unknown> = {};
    if (options.includeExternalAccounts === true) {
        query.include_external_accounts = 'true';
    }
    return get<OrganizationResponse>('organization', query);
}
