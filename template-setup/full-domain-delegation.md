# Full-Domain Delegation to Route 53

How to point a domain registered somewhere else (GoDaddy, Namecheap, Google
Domains/Squarespace, Cloudflare Registrar, …) at a Route 53 hosted zone, **without
transferring the registration**.

This is the DNS setup this template expects. `setup.sh` asks for a
`R53_HOSTED_ZONE_ID` / `DNS_HOSTED_ZONE` pair and the CDK stack writes records
into that zone directly, so the zone has to be authoritative for the domain before
a deploy can succeed.

---

## Registration and DNS are two separate services

| | Who provides it | What it does |
|---|---|---|
| **Registration** | Your registrar (GoDaddy) | Owns the entry in the registry: WHOIS, renewals, transfer locks. Also decides *which nameservers* the domain delegates to. |
| **DNS hosting** | Whoever runs those nameservers | Answers actual queries: A, AAAA, CNAME, MX, TXT records. |

Delegation is the one link between them: the registrar publishes an NS record set
at the registry saying "ask these servers." Change that pointer to AWS and Route 53
becomes authoritative. The registration never moves, no transfer, no auth code, no
60-day ICANN transfer lock, no renewal date change.

**Full delegation** hands Route 53 the entire domain, apex included. That is what
this document covers, and what the stack needs for its wildcard ACM certificate.

### The alternatives, and why this template wants full delegation

- **Subdomain delegation** — keep the registrar authoritative for `example.com`,
  create a Route 53 zone for `reader.example.com` only, and add NS records for the
  `reader` label at the registrar. Works, but the stack requests a wildcard cert
  for `*.${DNS_HOSTED_ZONE}`, and DNS validation for that name can only be written
  into a zone authoritative for `example.com`. You would have to narrow the cert
  and set `DNS_HOSTED_ZONE=reader.example.com`, which then also changes the derived
  site domain. Extra work, no benefit unless something else must stay at the
  registrar.
- **No hosted zone, CNAME at the registrar** — point a `CNAME` at the CloudFront
  distribution domain by hand. Subdomains only (DNS forbids a CNAME at a zone
  apex, and registrars rarely offer an ALIAS equivalent), and you lose automated
  ACM DNS validation and alias records. Not compatible with the CDK stack as
  written.

---

## Before you touch anything: inventory the current zone

The moment delegation flips, **every record still living only at the registrar
stops resolving.** Mail is the usual casualty. Write down what exists first.

In the registrar's DNS editor, export or screenshot the full record list. Pay
attention to:

| Record type | Typically used for | Break symptom if missed |
|---|---|---|
| `MX` | Inbound mail (Google Workspace, Microsoft 365, registrar-provided mailbox) | Mail bounces or silently stops |
| `TXT` (`v=spf1 …`) | SPF sender authorisation | Outbound mail lands in spam |
| `CNAME` / `TXT` on selector names | DKIM signing keys | Same |
| `TXT` on `_dmarc` | DMARC policy | Reporting stops; policy no longer enforced |
| `CNAME` on `autodiscover`, `enterpriseregistration`, `lyncdiscover`, `sip`, `msoid` | Microsoft 365 client setup | Outlook cannot auto-configure |
| `TXT` domain-verification strings | Google/Microsoft/Atlassian/etc. ownership proofs | Services deprovision after their recheck |
| `A` / `CNAME` at apex and `www` | An existing website | Site goes dark |
| `CAA` | Restricts which CAs may issue certs | See the CAA section below |
| `SRV` | VoIP, Minecraft, Teams federation | Service unreachable |

Also check for registrar-only features that have **no Route 53 equivalent**:
domain forwarding, URL/masked redirects, and email forwarding. GoDaddy implements
those with its own nameservers, so they stop working after delegation. Replace them
with an S3 redirect bucket plus CloudFront, or a CloudFront Function, if you need
them.

Two records you should **not** copy: the zone's own `NS` and `SOA`. Route 53
creates its own.

---

## Step 1 — Create the hosted zone

Console: **Route 53 → Hosted zones → Create hosted zone**. Domain name
`example.com` (the registrable domain, no `www`, no trailing dot needed), type
**Public hosted zone**.

CLI:

```bash
aws route53 create-hosted-zone \
  --name example.com \
  --caller-reference "rssnetwork-$(date +%s)" \
  --hosted-zone-config Comment="rssnetwork - delegated from GoDaddy"
```

`--caller-reference` just has to be unique per request; it is an idempotency token,
not a name.

The response contains `HostedZone.Id` (`/hostedzone/Z0123456789ABCDEFGHIJ` — the
value you want is the `Z…` part) and `DelegationSet.NameServers`.

> **Cost:** $0.50/month per hosted zone, prorated, plus $0.40 per million queries.
> Do not create a second zone for the same domain "to try again" — duplicate zones
> get *different* nameservers, and only the set you actually delegated to will be
> consulted. Delete the stray one.

### If you already have a zone for this domain

Reuse it. Get its id and nameservers:

```bash
aws route53 list-hosted-zones-by-name --dns-name example.com \
  --query 'HostedZones[].{Id:Id,Name:Name}' --output table

aws route53 get-hosted-zone --id Z0123456789ABCDEFGHIJ \
  --query 'DelegationSet.NameServers' --output text
```

---

## Step 2 — Recreate the inventoried records

Do this **before** flipping the nameservers. A zone that already has the right
answers makes the cutover invisible; an empty zone makes it an outage.

Console: **Route 53 → your zone → Create record**, one per row of your inventory.
Use the same name, type, value and (roughly) TTL.

CLI, for anything non-trivial, use a change batch:

```bash
cat > /tmp/records.json <<'JSON'
{
  "Comment": "Records migrated from GoDaddy",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "example.com.",
        "Type": "MX",
        "TTL": 3600,
        "ResourceRecords": [
          { "Value": "1 aspmx.l.google.com" },
          { "Value": "5 alt1.aspmx.l.google.com" },
          { "Value": "5 alt2.aspmx.l.google.com" }
        ]
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "example.com.",
        "Type": "TXT",
        "TTL": 3600,
        "ResourceRecords": [
          { "Value": "\"v=spf1 include:_spf.google.com ~all\"" }
        ]
      }
    }
  ]
}
JSON

aws route53 change-resource-record-sets \
  --hosted-zone-id Z0123456789ABCDEFGHIJ \
  --change-batch file:///tmp/records.json
```

Route 53 quirks worth knowing while doing this:

- **`TXT` values must be quoted inside the value.** The `\"…\"` above is not an
  escaping accident. A TXT string longer than 255 characters (long DKIM keys) has
  to be split into multiple quoted chunks in one value:
  `"first255chars" "remainder"`.
- **Multiple values of the same name+type go in one record set**, as separate
  `ResourceRecords` entries — not as several records. Creating two `MX` record sets
  with the same name is rejected.
- **Names are stored fully qualified** with a trailing dot. The console adds it.
- **Wildcards** are `*.example.com`, allowed, and do not match the apex.

Do not create the site's own `A` record here. The CDK stack owns
`reader.example.com` (and `reader-qa.example.com`) as CloudFront alias records — a
hand-made record on those names will collide on deploy with
`RRSet ... already exists`.

---

## Step 3 — Verify the zone answers correctly, before the cutover

Query the AWS nameservers directly. They will answer for your zone even while the
world is still being sent to the registrar, which is exactly what makes this safe
to check up front.

```bash
NS=$(aws route53 get-hosted-zone --id Z0123456789ABCDEFGHIJ \
      --query 'DelegationSet.NameServers[0]' --output text)

dig @"$NS" example.com     MX    +noall +answer
dig @"$NS" example.com     TXT   +noall +answer
dig @"$NS" www.example.com CNAME +noall +answer
```

Compare each answer against the current live answer from a public resolver:

```bash
dig @1.1.1.1 example.com MX +noall +answer
```

Anything that differs is a record you missed or fat-fingered. Fix it now.

---

## Step 4 — Lower the NS TTL at the registrar (optional but recommended)

Delegation `NS` records at the TLD commonly carry a 48-hour (172800s) TTL. Some
registrars let you shorten it; GoDaddy generally does not expose it. If yours does,
drop it to 300s a day ahead of the cutover so a rollback takes minutes instead of
days.

If you cannot change it, plan for up to 48 hours of mixed answers. In practice most
resolvers converge in well under an hour, but "most" is not "all," and this is
precisely why step 2 matters: during the overlap, *both* sets of nameservers are
being asked, so both must give the same answers.

---

## Step 5 — Change the nameservers at the registrar

**GoDaddy:** sign in → **My Products** → your domain → **DNS** (or **Manage DNS**)
→ scroll to **Nameservers** → **Change** → choose **I'll use my own nameservers**
(older UI: switch from "GoDaddy" to "Custom") → replace all entries with the four
from your delegation set → **Save**. GoDaddy shows a warning that its DNS settings
will stop being used; that is the intended effect. It may also require you to
disable its parked/forwarding page first.

Enter all four. Trailing dots are optional and GoDaddy strips them. They look like:

```
ns-123.awsdns-45.com
ns-678.awsdns-90.net
ns-1234.awsdns-56.org
ns-789.awsdns-01.co.uk
```

The four different TLDs are deliberate — AWS spreads the delegation set across
`.com`/`.net`/`.org`/`.co.uk` so a single TLD's outage cannot take your domain
offline. Do not "tidy" them.

Other registrars: the setting is usually under *Nameservers*, *DNS management*, or
*Custom DNS*. Namecheap: **Domain → Nameservers → Custom DNS**. Cloudflare
Registrar: **Domain → DNS → Custom nameservers** (requires a paid plan;
Cloudflare's free tier forces its own nameservers, which makes full delegation to
Route 53 impossible there).

### If the domain is DNSSEC-signed

Disable DNSSEC at the registrar **before** changing nameservers, and wait for the
DS record to clear the registry (up to the DS TTL, often a day). Moving delegation
while a DS record still points at the old signer makes validating resolvers treat
every answer as bogus — a hard failure, not a soft one, and worse than a plain
misconfiguration. Re-enable DNSSEC afterwards using Route 53's own KSK if you want
it.

---

## Step 6 — Confirm propagation

Check the parent (the TLD's own view — this is the authoritative statement of where
delegation points, and it updates within minutes of the registrar saving):

```bash
dig +trace example.com NS | tail -20

# or ask a gTLD server directly
dig @a.gtld-servers.net example.com NS +noall +authority
```

Check what resolvers are handing out (this is the part that lags behind cache):

```bash
for r in 1.1.1.1 8.8.8.8 9.9.9.9 208.67.222.222; do
  printf '%-16s %s\n' "$r" "$(dig @$r example.com NS +short | sort | tr '\n' ' ')"
done
```

Check the registry record itself:

```bash
whois example.com | grep -i 'name server'
```

Done when the parent shows the four `awsdns` names and public resolvers agree.

---

## Step 7 — Wire it into this repo

Once delegation is live:

```bash
./template-setup/setup.sh
```

At the Route 53 step, enter either the zone id or the bare domain — `setup.sh`
resolves whichever you omit via `aws route53 get-hosted-zone` /
`list-hosted-zones-by-name` and writes both:

```
R53_HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ
DNS_HOSTED_ZONE=example.com
```

Site domains are derived from those plus `SITE_NAME`, as
`<SITE_NAME>.<DNS_HOSTED_ZONE>` and `<SITE_NAME>-qa.<DNS_HOSTED_ZONE>`.

Then:

```bash
./infrastructure/deploy.sh
```

What the stack does with the zone (`infrastructure/lib/infrastructure-stack.ts`):

1. Imports it with `HostedZone.fromHostedZoneAttributes` — **imported, never
   created.** CDK will not manage or delete your zone.
2. Requests an ACM certificate for `*.${DNS_HOSTED_ZONE}` with
   `CertificateValidation.fromDns(certZone)`, which writes a `_<hash>.example.com`
   CNAME into the zone and waits for AWS to see it.
3. Creates an A-alias record for the stage's site domain targeting the CloudFront
   distribution.

### The one hard ordering constraint

**Do not deploy until delegation has propagated.** ACM validates by resolving the
challenge record from the public internet. If the registrar's nameservers are still
authoritative, Route 53 holds a record nobody can see, and CloudFormation sits on
`CREATE_IN_PROGRESS` for the certificate until it times out — historically around
30–60 minutes, and a rolled-back stack you then have to clean up. Confirm step 6
first.

### CAA records will block issuance if they exclude Amazon

If the domain has any `CAA` record, ACM can only issue when one of them authorises
Amazon. Check both the old registrar zone and your new Route 53 zone:

```bash
dig example.com CAA +short
```

Empty output means no restriction, and you are fine. If records exist, add:

```
0 issue "amazon.com"
0 issuewild "amazon.com"
```

`issuewild` matters here specifically because the cert is a wildcard: a CAA set
with `issue "amazon.com"` but a restrictive `issuewild` still fails.

### Region

The certificate is consumed by CloudFront, which only accepts certs from
`us-east-1`. The stack creates the cert inline, so the whole stack must deploy to
`us-east-1` — keep `AWS_REGION=us-east-1` in `config.env`.

---

## After the cutover

- **The registrar still matters.** Renewals, WHOIS/privacy, transfer lock, and the
  nameserver setting itself all stay there. If the registration lapses, the Route 53
  zone keeps answering but nothing will ask it.
- **The registrar's DNS editor is now inert.** Records still shown there are not
  served. Edit only in Route 53. This is the single most common source of "I changed
  the record and nothing happened."
- **Zone id is stable, nameservers are stable.** Neither changes for the life of the
  zone. Delete and recreate the zone and you get a *new* delegation set, requiring
  another registrar change — so don't casually `cdk destroy` your way into deleting
  it (the stack imports rather than owns the zone specifically to prevent that).
- **`cdk destroy` leaves the zone behind**, correctly. If you are abandoning the
  project, delete the hosted zone manually to stop the $0.50/month.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `dig NS` still returns registrar nameservers after hours | Save didn't take, or resolver cache | Re-check the registrar UI; compare `dig +trace` (parent) against `dig @8.8.8.8` (cache). Parent is truth. |
| Mail stopped at cutover | `MX`/SPF/DKIM not recreated | Add them to Route 53 now; propagation is fast once the zone is authoritative. |
| CDK hangs on `SiteCert…` | Delegation not live, or CAA blocks Amazon | Verify step 6 and the CAA section, then redeploy. |
| ACM stuck `PENDING_VALIDATION`, delegation *is* live | Two hosted zones for the domain; the challenge went into the undelegated one | `list-hosted-zones-by-name`, delete the duplicate, ensure `R53_HOSTED_ZONE_ID` is the delegated zone, redeploy. |
| `RRSet with DNS name … already exists` | A hand-made record on the site domain | Delete it from the zone; the stack owns that name. |
| Site resolves but serves the wrong thing | `A` record points at an old target, or CloudFront cache | Confirm the alias target is the current distribution; invalidate. |
| Domain intermittently fails to resolve at all | DNSSEC DS record left in place across the move | Remove the DS at the registrar, or re-sign the zone in Route 53. |
| SSL warning on the apex `example.com` | Wildcard `*.example.com` does not cover the apex | Expected. The stack only serves `<SITE_NAME>.example.com`. Add the apex to `domainNames` and the cert's SANs if you want it. |

## Rollback

Set the registrar's nameservers back to its defaults (GoDaddy: **Change → Default**
/ **GoDaddy nameservers**). Propagation is bounded by the same NS TTL as the
forward move. Keep the Route 53 zone while you sort things out — it costs $0.50/month
and preserves the records and the delegation set, so a second attempt needs no
registrar change beyond re-entering the same four nameservers.

---

## Quick reference

```bash
ZONE=example.com
ZID=$(aws route53 list-hosted-zones-by-name --dns-name "$ZONE" \
       --query 'HostedZones[0].Id' --output text | sed 's|/hostedzone/||')

# nameservers to enter at the registrar
aws route53 get-hosted-zone --id "$ZID" \
  --query 'DelegationSet.NameServers' --output text

# everything currently in the zone
aws route53 list-resource-record-sets --hosted-zone-id "$ZID" \
  --query 'ResourceRecordSets[].{Name:Name,Type:Type,TTL:TTL,Value:ResourceRecords[0].Value}' \
  --output table

# is delegation live?
dig +trace "$ZONE" NS | tail -5
dig @8.8.8.8 "$ZONE" NS +short
```
