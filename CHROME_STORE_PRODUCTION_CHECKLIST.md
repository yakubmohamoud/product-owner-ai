# Chrome Web Store Production Checklist

## Completed in this repository

- Chrome Manifest V3 extension with product description and icons.
- Configurable production API URL with a local-development override stored in extension storage.
- Extension packaging command: `npm run package:extension`.
- Production Docker configuration and environment template.
- Privacy-policy draft requiring publisher-specific review.
- Automated backend, OAuth, encryption, billing and workspace tests.

## Publisher actions before submission

1. Deploy the API behind HTTPS at `https://api.productownerai.com` (or replace that hostname consistently in the manifest, extension default, OAuth, Stripe and deployment configuration).
2. Register the final Chrome extension ID and set it as `EXTENSION_ORIGIN=chrome-extension://<id>` in the production environment.
3. Register production callback URLs with Google and Atlassian. A callback must exactly match the deployed `PUBLIC_BASE_URL`, for example `https://api.productownerai.com/auth/google/callback` and `.../auth/atlassian/callback`.
4. Set strong production secrets and rotate all credentials previously shared in chat. Store Stripe, Atlassian, Google and AI provider secrets in platform secret management only.
5. Configure Stripe production keys, webhook signing secret and live price IDs. Confirm the webhook endpoint at `/api/billing/webhook` and run live-mode test checkout and refunds.
6. Publish the reviewed privacy policy and support page over HTTPS. Replace the draft placeholder domains and publisher legal details.
7. Create Chrome Web Store screenshots (1280×800 recommended), a small promotional tile (440×280), and a marquee tile (1400×560) if selected.
8. Register or sign into the Chrome Web Store developer account, pay the one-time developer-registration fee, and select the publisher.
9. Upload `dist/product-owner-ai-chrome.zip`, complete permissions and data-use declarations, supply screenshots, and submit for review.

## Permission justification

- `storage`: remembers the selected API server and extension UI state locally.
- Host access to the configured HTTPS API: communicates with the authenticated backend for generation, projects, Jira, Confluence, media classification, and billing.
- Host access to localhost: development-only fallback and must be removed from the Store build after validating the production hostname.

## Suggested release verification

- Install the uploaded ZIP as an unpacked extension and confirm sign-in, generation, document upload, recording classification, Jira creation, Confluence creation, subscription checkout and credit checkout.
- Verify production cookies and OAuth callbacks from Chrome, including third-party cookie restrictions.
- Run `npm test`, `npm run smoke`, and `npm run package:extension` before every release.
