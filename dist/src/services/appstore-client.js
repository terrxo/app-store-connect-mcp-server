import axios from 'axios';
import { AuthService } from './auth.js';
export class AppStoreConnectClient {
    axiosInstance;
    authService;
    constructor(config) {
        this.authService = new AuthService(config);
        this.authService.validateConfig();
        this.axiosInstance = axios.create({
            baseURL: 'https://api.appstoreconnect.apple.com/v1',
        });
    }
    async request(method, url, data, params) {
        const token = await this.authService.generateToken();
        const response = await this.axiosInstance.request({
            method,
            url,
            data,
            params,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    }
    async get(url, params) {
        return this.request('GET', url, undefined, params);
    }
    async post(url, data) {
        return this.request('POST', url, data);
    }
    async put(url, data) {
        return this.request('PUT', url, data);
    }
    async delete(url, data) {
        return this.request('DELETE', url, data);
    }
    async patch(url, data) {
        return this.request('PATCH', url, data);
    }
    async downloadFromUrl(url) {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            throw new Error(`Invalid download URL: ${url}`);
        }
        if (parsed.protocol !== 'https:' || !/(^|\.)apple\.com$/.test(parsed.hostname)) {
            throw new Error(`Refusing to send Apple JWT to non-Apple host: ${parsed.hostname}`);
        }
        const token = await this.authService.generateToken();
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        return {
            data: response.data,
            contentType: response.headers['content-type'],
            size: response.headers['content-length']
        };
    }
}
