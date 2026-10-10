# Intelligence signup and OpenMuse usage tracking

OpenMuse uses the CopilotKit SDK's existing telemetry transport. There is no
separate PostHog SDK or PostHog key to configure in this application.

## Configure the server

Run these commands from the OpenMuse root:

```sh
npx copilotkit@latest login
npx copilotkit@latest project select
```

Keep both generated values in the server environment:

| Variable | Purpose |
| --- | --- |
| `CPK_INTELLIGENCE_API_KEY` | Optional server-only project key that stores Rich Threads in Intelligence. Without it, conversations stay in the API's own database ([local mode](STANDALONE-THREADS.md)). |
| `CPK_TELEMETRY_ID` | CLI-issued project binding that the telemetry sink can resolve to an Intelligence account. |

Deploy the values for the selected project together. Do not generate your own
telemetry ID, reuse another project's ID, or put either value in public Expo
variables. An API key alone does not give runtime telemetry a resolvable identity.
If the CLI reports an identity provisioning failure, resolve that failure and
run project selection again before claiming account attribution works.

The Render Blueprint prompts for both values. For an existing Render service,
add `CPK_TELEMETRY_ID` in the API service's Environment settings and redeploy the
tracking commit; adding it to the Blueprint does not populate an existing service.

The SDK sends existing runtime events to
`https://telemetry.copilotkit.ai/ingest`. OpenMuse adds
`accessibility_title: "OpenMuse"` and defaults
`COPILOTKIT_TELEMETRY_SAMPLE_RATE` to `1` so setup and usage events are not
randomly sampled away. It respects an explicit sampling override.

Remove old deployment settings that disable telemetry if tracking is desired.
To opt out, set either `COPILOTKIT_TELEMETRY_DISABLED=true` or `DO_NOT_TRACK=1`
and restart the API. Both variables accept `true` or `1`. The isolated demo
and automated test fixtures disable telemetry.

## What the events measure

- `intelligence_signup`: an Intelligence account created in Clerk, emitted by
  the existing backend sync with the Clerk user ID as its PostHog `distinct_id`.
- `oss.runtime.instance_created`: the OpenMuse runtime handler was created.
- `oss.runtime.copilot_request_created`: a request reached the runtime; this is
  usage evidence, not proof of a successful model answer.

The sink enriches runtime events with `telemetry_id`, and with `clerk_user_id`
when that identity resolves. Runtime and signup events can have different
PostHog `distinct_id` values: join the runtime `clerk_user_id` property to the
signup `distinct_id` rather than assuming a standard person funnel joins them.

This connects completed signups to OpenMuse usage. It does not prove OpenMuse
was the acquisition source: the account might predate OpenMuse. Measuring
acquisition requires carrying a source through the Intelligence signup flow.
OpenMuse does not emit a duplicate signup event on startup, login or key entry.

## Validate in PostHog

After deploying, restart the API and make one chat request. In
[PostHog project 26816](https://eu.posthog.com/project/26816), run:

```sql
SELECT event, timestamp, distinct_id,
       properties.accessibility_title AS app,
       properties.telemetry_id AS telemetry_id,
       properties.clerk_user_id AS clerk_user_id
FROM events
WHERE event IN (
    'oss.runtime.instance_created',
    'oss.runtime.copilot_request_created'
  )
  AND properties.accessibility_title = 'OpenMuse'
  AND timestamp >= now() - INTERVAL 1 DAY
ORDER BY timestamp DESC
LIMIT 20
```

Confirm the tag, the expected telemetry identity and the resolved Clerk subject.
Then find that subject's `intelligence_signup` event. To count accounts signed
up in the last 30 days that also used OpenMuse in that period:

```sql
SELECT count(DISTINCT signup.distinct_id) AS signups_with_openmuse_usage
FROM events AS signup
INNER JOIN (
  SELECT DISTINCT properties.clerk_user_id AS clerk_user_id
  FROM events
  WHERE event = 'oss.runtime.copilot_request_created'
    AND properties.accessibility_title = 'OpenMuse'
    AND timestamp >= now() - INTERVAL 30 DAY
    AND notEmpty(toString(properties.clerk_user_id))
) AS usage ON signup.distinct_id = usage.clerk_user_id
WHERE signup.event = 'intelligence_signup'
  AND signup.timestamp >= now() - INTERVAL 30 DAY
```

For OpenDots, use the same runtime configuration with the app tag `OpenDots`
and its own CLI-issued project identity, then change the tag filter.

An HTTP `202` from ingest alone does not prove PostHog delivery. If the event
or identity enrichment is missing, check the deployed server environment and
the `TelemetrySinkIngest` / `TelemetrySinkFanout` CloudWatch logs. The canonical
reporting surface is [dashboard 664553](https://eu.posthog.com/project/26816/dashboard/664553).

## Local verification

`pnpm test` disables production telemetry for ordinary fixtures. The telemetry
tests start fresh processes, intercept SDK fetch calls before importing it,
and check the OpenMuse tag, CLI-issued identity header, full sampling, explicit
sampling override, both opt-outs and absence of the project key in the payload.
These checks prove the local SDK contract; production delivery and identity
resolution require the PostHog checks above.
