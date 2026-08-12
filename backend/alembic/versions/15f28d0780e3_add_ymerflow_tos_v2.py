"""Add YmerFlow ToS/Privacy Policy version 2

Revision ID: 15f28d0780e3
Revises: 4977b82dd8fc
Create Date: 2026-08-11 00:00:00.000000

"""
from typing import Sequence, Union
from datetime import datetime

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql import table, column


# revision identifiers, used by Alembic.
revision: str = '15f28d0780e3'
down_revision: Union[str, Sequence[str], None] = '4977b82dd8fc'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TOS_BODY = """# Part I — Terms of Service

## 1. Who this agreement is with

These Terms of Service ("**Terms**") are between **YmerFlow Inc**, a Wyoming corporation (registered office: 5830 E 2nd St, Ste 7000 #37636, Casper, WY 82609) ("**YmerFlow**," "**we**," "**us**"), and the entity or individual using the YmerFlow platform ("**Customer**," "**you**"). By creating an account or using the Service, you agree to these Terms on behalf of yourself and, if applicable, the organization you represent — you confirm you have authority to bind that organization.

## 2. The Service

YmerFlow is a browser-based platform for processing and inverting geophysical survey data (airborne electromagnetic, magnetic, gravity, and related methods) ("**Service**"). The entire Service — including data processing, inversion, workflow orchestration, and the browser UI — is open-source software published by YmerFlow under the GNU General Public License v3 (GPLv3), available at ymerflow.org, and can be self-hosted independently of YmerFlow's hosted offering (e.g. deployed locally on minikube). The billing plugin used in YmerFlow's own hosted deployment is proprietary and not part of the open-source release (future commercial plugins, if any, would be similarly scoped and disclosed here). What you're paying for when you use YmerFlow's hosted Service is the hosting, operation, and support YmerFlow provides on top of that code, not exclusive access to the code itself. Nothing in these Terms restricts your rights under GPLv3 for the open-source code — that license governs the code itself; these Terms govern your use of YmerFlow's hosted Service specifically.

## 3. Accounts

You must provide accurate account and billing information and keep your credentials confidential. You're responsible for activity under your account. Notify us promptly at the contact in §14 if you suspect unauthorized use.

## 4. Fees and billing

Some tiers of the Service are free; paid tiers are billed via Dodo Payments on a subscription and/or compute-credit basis as described on our pricing page at the time of purchase. Fees are non-refundable except as required by law or stated otherwise at purchase. We may suspend access for non-payment after reasonable notice. We'll give at least 30 days' notice before a price change takes effect for your existing subscription.

## 5. Your data

**5.1 Ownership.** As between you and YmerFlow, you own all right, title, and interest in (a) the raw survey data and other files you upload ("**Customer Data**") and (b) the processed results, inversion models, and other outputs the Service generates from Customer Data ("**Outputs**"). We claim no ownership over either.

**5.2 License to us.** You grant YmerFlow a limited, non-exclusive license to host, process, transmit, and display Customer Data and Outputs solely as needed to provide and support the Service to you. We do not use Customer Data or Outputs to train models, improve the Service generally, or for any purpose beyond delivering the Service to you, without your separate written permission.

**5.3 Usage Data.** Separately from Customer Data, we collect technical and operational data about how the Service is used — job metrics, performance statistics, error logs, and similar telemetry ("**Usage Data**"). Usage Data does not include the content of your survey data or Outputs. We own Usage Data and may use it in aggregated or anonymized form to operate, support, and improve the Service.

**5.4 Confidentiality.** We treat Customer Data as confidential and will protect it to at least the same degree of care we use to protect our own confidential information, and no less than reasonable care. We limit internal access to employees and contractors who need it to provide the Service. We won't disclose Customer Data to third parties except: subprocessors bound by confidentiality obligations at least as protective as this section (e.g. our cloud hosting provider), as required by law, or with your consent.

**5.5 On termination.** Customer Data and Outputs can be exported at any time via the Service's self-serve project export function. After your account closes, we'll retain Customer Data and Outputs for **90 days** to allow export, then delete them, except backup copies that age out on their normal cycle or data we're required to retain by law.

**5.6 Regulatory embargoes.** If your jurisdiction or a government contract requires you to keep exploration data confidential until a future release date, that obligation is between you and your regulator — YmerFlow is not a party to it and doesn't independently monitor or enforce it, whether or not the Service offers scheduling features for it.

## 6. Acceptable use

Don't use the Service to: violate law; upload data you don't have the rights or permissions to use; attempt to breach security or access other customers' data; reverse-engineer the proprietary (non-open-source) billing plugin described in §2 — the open-source parts of the Service are governed by GPLv3 instead, which already grants those rights; or resell the Service without our written agreement.

## 7. Results are not guaranteed accurate

**This is the most important section for how you use YmerFlow's output.**

Geophysical inversion computes a best-fit model from your input data — it is inherently a predictive, non-unique solution to an inverse problem, not a deterministic calculation, and its quality depends heavily on the quality of your input data, which we do not control. **You are solely responsible for reviewing, validating, and interpreting all Outputs before relying on them** for drilling, capital-allocation, regulatory, or any other decision. YmerFlow disclaims all liability for decisions made based on Outputs or other results of the Service. Independently verify any Output before acting on it, especially for decisions with financial, safety, or legal consequences.

## 8. Disclaimer of warranties; limitation of liability

**8.1 As-is.** THE SERVICE AND ALL OUTPUTS ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND ACCURACY. WE DON'T WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT OUTPUTS WILL BE ACCURATE, COMPLETE, OR RELIABLE. SEE §7 FOR OUR SPECIFIC DISCLAIMER ON INVERSION AND PROCESSING RESULTS.

**8.2 Cap.** TO THE MAXIMUM EXTENT PERMITTED BY LAW, EACH PARTY'S TOTAL LIABILITY ARISING OUT OF OR RELATED TO THESE TERMS WILL NOT EXCEED THE LESSER OF (A) THE FEES YOU PAID YMERFLOW IN THE 12 MONTHS BEFORE THE CLAIM AROSE, OR (B) **US $10,000**.

**8.3 Exclusions.** NEITHER PARTY IS LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR LOST PROFITS, REVENUE, OR DATA, EVEN IF ADVISED OF THE POSSIBILITY. THESE LIMITS DON'T APPLY TO: breach of §5.4 (confidentiality), payment obligations, or liability that can't be limited under applicable law.

## 9. Indemnification

You'll defend and indemnify YmerFlow against third-party claims arising from your breach of these Terms, your Customer Data infringing or misappropriating a third party's rights, or your violation of law, to the extent caused by you.

## 10. Term and termination

Either party may terminate for convenience with 30 days' written notice, or immediately for material breach not cured within 15 days of notice. We may suspend or terminate immediately for non-payment, security risk, or illegal use. §5 (data), §7–9, and §11–13 survive termination.

## 11. Changes to the Service or these Terms

We may modify the Service or these Terms. For material changes, we'll give at least 30 days' notice (email or in-app) before they take effect for existing customers. Continued use after the effective date means you accept the changes.

## 12. Governing law and disputes

These Terms are governed by the laws of the State of Wyoming, without regard to conflict-of-laws rules.

## 13. Miscellaneous

These Terms, plus any order form or pricing page you agreed to, are the entire agreement between you and YmerFlow regarding the Service, superseding prior discussions. If a provision is unenforceable, the rest remains in effect. Neither party may assign these Terms without the other's consent, except to a successor in a merger or sale of substantially all assets. No waiver of a breach is a waiver of any other.

## 14. Contact

Questions about these Terms: **legal@ymerflow.com** (or the contact address published on ymerflow.com at the time).

---

# Part II — Privacy Policy

This Privacy Policy explains what personal data YmerFlow Inc collects through the YmerFlow platform (the "Service") and how we use it. It covers personal data only — it does not cover Customer Data (your uploaded survey data) or Outputs, which are addressed in Part I §5 above.

## 1. Who we are

YmerFlow Inc, a Wyoming corporation, registered office 5830 E 2nd St, Ste 7000 #37636, Casper, WY 82609. Contact: **privacy@ymerflow.com**.

## 2. What we collect

| Category | Examples | Source |
|---|---|---|
| Account data | Name, work email, organization, role, password (hashed) | You, at signup |
| Billing data | Billing address, payment method details | You, via our payment processor (Dodo Payments) — we don't store full card numbers ourselves |
| Usage/telemetry data | Login times, job submissions, compute usage, feature interactions, error logs, IP address, browser/device info | Automatically, as you use the Service |
| Support communications | Content of support requests and correspondence | You |
| Cookies | Session and functional cookies (see §7) | Automatically |

We do **not** treat your uploaded survey data or computed Outputs as personal data for purposes of this policy unless they happen to contain identifiable information about a person — that's addressed contractually in Part I §5, not here.

## 3. How we use it

- Provide, operate, and secure the Service (authentication, job processing, billing)
- Communicate with you about your account, invoices, and service changes
- Provide support
- Monitor and improve platform performance and reliability
- Detect and prevent abuse, fraud, and security incidents
- Comply with legal and tax obligations (e.g. billing records)

We don't sell personal data, and we don't use it for third-party advertising.

## 4. Legal basis (for users in the EEA/UK)

We process personal data under: performance of a contract (running your account and billing), our legitimate interests (securing and improving the Service, in each case balanced against your rights), and legal obligation (tax/accounting records). Where required, we'll ask for consent separately (e.g. optional marketing emails).

## 5. Who we share it with

We share personal data only with service providers who process it on our behalf under contractual confidentiality and data-protection obligations, currently:

- **Payment processing:** Dodo Payments
- **Cloud hosting/infrastructure:** Google Cloud Platform
- Other subprocessors we add will be listed here as they're engaged.

We may also disclose personal data if required by law, subpoena, or valid legal process, or to protect the rights, property, or safety of YmerFlow, our customers, or others.

## 6. International transfers

YmerFlow is a US company and hosts the Service on infrastructure that may be located in the US or other countries. If you're in the EEA, UK, or another jurisdiction with data-transfer restrictions, your personal data may be transferred outside your jurisdiction. Where required, we rely on appropriate safeguards (such as Standard Contractual Clauses) for these transfers — details available on request.

## 7. Cookies

We use strictly necessary cookies (session/authentication) and functional cookies (remembering preferences). We don't currently use third-party advertising or tracking cookies. You can control cookies through your browser settings, though disabling necessary cookies may break login.

## 8. Data retention

We keep account and billing data for as long as your account is active, plus a reasonable period after closure for legal, tax, and dispute-resolution purposes (typically up to 7 years for billing records, consistent with standard tax record-keeping). Usage/telemetry data is retained for up to 24 months for operational and security purposes, then deleted or aggregated. See Part I §5.5 for Customer Data and Output retention specifically.

## 9. Security

We use reasonable administrative, technical, and organizational measures to protect personal data, including encryption in transit, access controls limited to staff who need it, and our cloud provider's infrastructure security. No system is 100% secure; we can't guarantee absolute security.

## 10. Your rights

You may have the right to access, correct, delete, or export your personal data, restrict or object to certain processing, and (where processing is based on consent) withdraw consent at any time. **Deletion:** wherever you're located, we'll delete your personal data in line with GDPR requirements, regardless of your country of residence. **Export:** your projects, survey data, and Outputs can be exported anytime via the Service's self-serve project export function (Part I §5.5); to export your personal data specifically, email us and we'll handle it as a request under this section. To exercise any of these rights, contact **privacy@ymerflow.com**. We'll respond within a reasonable time (30 days for GDPR-covered requests). If you're in the EEA/UK and believe we haven't resolved your concern, you may lodge a complaint with your local data protection authority.

## 11. Children's privacy

The Service is intended for business use by professionals and organizations, not children. We don't knowingly collect personal data from anyone under 16.

## 12. Changes to this policy

We may update this policy as the Service evolves. For material changes, we'll give at least 30 days' notice (email or in-app) before they take effect. The "Effective date" above reflects the latest version.

## 13. Contact

Questions or requests regarding this policy or your personal data: **privacy@ymerflow.com**.
"""


def upgrade() -> None:
    tos_versions = table(
        'tos_versions',
        column('version', sa.Integer),
        column('body', sa.Text),
        column('created_at', sa.DateTime),
        column('created_by', sa.Integer),
    )
    bind = op.get_bind()
    next_version = bind.execute(
        sa.select(sa.func.coalesce(sa.func.max(tos_versions.c.version), 0) + 1)
    ).scalar()

    op.execute(
        tos_versions.insert().values(
            version=next_version,
            body=TOS_BODY,
            created_at=datetime.utcnow(),
            created_by=None,
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text("DELETE FROM tos_versions WHERE body = :body").bindparams(body=TOS_BODY)
    )
