import http from "node:http";
export interface ServerOptions {
    port?: number;
    openBrowser?: boolean;
}
export declare function startLocalDashboard(options?: ServerOptions): Promise<{
    server: http.Server;
    url: string;
}>;
