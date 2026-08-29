export interface BrowserCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure?: boolean;
}

export function parseCookieHeader(cookieStr: string, domain: string): BrowserCookie[] {
	if (!cookieStr?.trim() || cookieStr.startsWith("{")) return [];
	return cookieStr
		.split(";")
		.filter((c) => c.trim().includes("="))
		.map((c) => {
			const [name, ...valueParts] = c.trim().split("=");
			let value = valueParts.join("=").trim();
			// Strip surrounding quotes (e.g. xiaomichatbot_serviceToken="...") — the raw Cookie
			// header stores quoted values, but BrowserContext.addCookies expects raw value without
			// quotes. Keeping quotes causes the cookie to be set with literal quotes and breaks auth.
			if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
				value = value.slice(1, -1);
			}
			return {
				name: name?.trim() ?? "",
				value,
				domain,
				path: "/",
			};
		})
		.filter((c) => c.name.length > 0);
}
