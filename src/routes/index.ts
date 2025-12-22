import { getBodyBuffer } from '@/utils/body';
import {
  getProxyHeaders,
  getAfterResponseHeaders,
  getBlacklistedHeaders,
} from '@/utils/headers';
import {
  createTokenIfNeeded,
  isAllowedToMakeRequest,
  setTokenHeader,
} from '@/utils/turnstile';

export default defineEventHandler(async (event) => {
  // Handle preflight CORS requests
  // Handle preflight CORS requests
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, CONNECT, OPTIONS, TRACE, PATCH',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  });

  if (isPreflightRequest(event)) {
    event.node.res.statusCode = 204;
    event.node.res.end();
    return;
  }

  // Reject any other OPTIONS requests
  if (event.node.req.method === 'OPTIONS') {
    throw createError({
      statusCode: 405,
      statusMessage: 'Method Not Allowed',
    });
  }

  // Parse destination URL and headers from query
  const query = getQuery<{ destination?: string, headers?: string }>(event);
  const destination = query.destination;
  const headersParam = query.headers;

  if (!destination) {
    return await sendJson({
      event,
      status: 200,
      data: {
        message: `Proxy is working as expected (v${useRuntimeConfig(event).version
          })`,
      },
    });
  }

  let queryHeaders: Record<string, string> = {};
  if (headersParam) {
    try {
      queryHeaders = JSON.parse(headersParam);
    } catch (e) {
      // Ignore invalid JSON
    }
  }

  // Check if allowed to make the request
  if (!(await isAllowedToMakeRequest(event))) {
    return await sendJson({
      event,
      status: 401,
      data: {
        error: 'Invalid or missing token',
      },
    });
  }

  // Read body and create token if needed
  const body = await getBodyBuffer(event);
  const token = await createTokenIfNeeded(event);

  // Proxy the request
  try {
    const fetchHeaders = getProxyHeaders(event.headers);
    // Merge headers from query param (these are usually real names like 'Referer')
    Object.entries(queryHeaders).forEach(([k, v]) => {
      fetchHeaders.set(k, v);
    });

    await specificProxyRequest(event, destination, {
      blacklistedHeaders: getBlacklistedHeaders(),
      fetchOptions: {
        redirect: 'follow',
        headers: fetchHeaders,
        body,
      },
      onResponse(outputEvent, response) {
        const headers = getAfterResponseHeaders(response.headers, response.url);
        setResponseHeaders(outputEvent, headers);
        if (token) setTokenHeader(event, token);
      },
    });
  } catch (e) {
    console.log('Error fetching', e);
    throw e;
  }
});