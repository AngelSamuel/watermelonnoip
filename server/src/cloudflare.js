const CF_TOKEN = process.env.CF_API_TOKEN;
const ZONE_ID = process.env.CF_ZONE_ID;
const BASE_DOMAIN = process.env.DOMAIN || "watermelonmarketing.com";

async function cfFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${CF_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await res.json();
  if (!data.success) {
    const err = data.errors?.map(e => e.message).join(", ") || "Cloudflare API Error";
    throw new Error(err);
  }
  return data;
}

async function getOrCreateRecord(subdomain, currentIp = "1.1.1.1") {
  const fullDomain = `${subdomain}.${BASE_DOMAIN}`;
  const searchUrl = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=A&name=${fullDomain}`;
  const searchData = await cfFetch(searchUrl);

  if (searchData.result && searchData.result.length > 0) {
    const record = searchData.result[0];
    return { recordId: record.id, ip: record.content };
  }

  const createUrl = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`;
  const createData = await cfFetch(createUrl, {
    method: "POST",
    body: JSON.stringify({
      type: "A",
      name: fullDomain,
      content: currentIp,
      ttl: 120,
      proxied: false
    })
  });

  return { recordId: createData.result.id, ip: createData.result.content };
}

async function updateRecord(recordId, subdomain, newIp) {
  const fullDomain = `${subdomain}.${BASE_DOMAIN}`;
  const updateUrl = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${recordId}`;
  await cfFetch(updateUrl, {
    method: "PUT",
    body: JSON.stringify({
      type: "A",
      name: fullDomain,
      content: newIp,
      ttl: 120,
      proxied: false
    })
  });
}

module.exports = { getOrCreateRecord, updateRecord };
