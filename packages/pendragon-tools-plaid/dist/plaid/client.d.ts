import type { DomainType } from '../types.js';
export declare class ScopedPlaidClient {
    private client;
    private domainType;
    private allowedOps;
    constructor(clientId: string, secret: string, env: string, domainType: DomainType);
    private assertAllowed;
    getAllowedOps(): string[];
    accountsGet(accessToken: string): Promise<import("axios", { with: { "resolution-mode": "require" } }).AxiosResponse<import("plaid").AccountsGetResponse, any, {}>>;
    transactionsSync(accessToken: string, cursor?: string): Promise<import("axios", { with: { "resolution-mode": "require" } }).AxiosResponse<import("plaid").TransactionsSyncResponse, any, {}>>;
    investmentsHoldingsGet(accessToken: string): Promise<import("axios", { with: { "resolution-mode": "require" } }).AxiosResponse<import("plaid").InvestmentsHoldingsGetResponse, any, {}>>;
    liabilitiesGet(accessToken: string): Promise<import("axios", { with: { "resolution-mode": "require" } }).AxiosResponse<import("plaid").LiabilitiesGetResponse, any, {}>>;
}
//# sourceMappingURL=client.d.ts.map