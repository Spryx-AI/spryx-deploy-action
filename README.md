# Spryx Deploy Action

GitHub Action to deploy Docker images to Railway and wait for the deployment to complete, with optional Sentry release tracking.

## Flow

```mermaid
flowchart TD
    A([Start]) --> B[Parse inputs]
    B --> C{Valid services?}
    C -- No --> Z([Fail])
    C -- Yes --> D[Spawn parallel deploys]

    subgraph Railway [Railway — each service runs in parallel]
        D --> E1[Service 1: update source.image]
        D --> E2[Service N: update source.image]
        E1 --> F1[Service 1: trigger deploy]
        E2 --> F2[Service N: trigger deploy]
        F1 --> G1[Service 1: poll until terminal state]
        F2 --> G2[Service N: poll until terminal state]
    end

    G1 & G2 --> H[All deploys completed]
    H --> I{sentry_auth_token provided?}
    I -- No --> J([Done])

    subgraph Sentry
        I -- Yes --> K[Create release]
        K --> L[Associate commits to release]
        L --> M[Register deploy in environment]
    end

    M --> J
```

## How it works

1. The CI pipeline builds the Docker image with `RELEASE` baked in as a build arg
2. The image is published to a registry (e.g. GHCR)
3. This action updates the `source.image` of each Railway service via GraphQL API and triggers the deploy
4. It then polls the Railway API every 10 seconds until each deployment reaches a terminal state (`SUCCESS`, `FAILED`, `CRASHED`)
5. Optionally, registers the release and deploy in Sentry

Since `RELEASE` lives inside the image, there is no risk of inconsistency between the version variable and the running container — if the deploy fails, the old container keeps running with its own version.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `services` | ✅ | — | JSON array of `{ serviceId, image }` pairs |
| `environment_id` | ✅ | — | Railway environment ID |
| `environment` | ✅ | — | Target environment name (e.g. `staging`, `production`) |
| `railway_token` | ✅ | — | Railway workspace token |
| `release_name` | ✅ | — | Release name (e.g. `my-app@1.2.3`) |
| `deploy_wait_timeout_minutes` | ❌ | `10` | How long to wait for each deployment to reach a terminal state (minutes) |
| `sentry_auth_token` | ❌ | — | Sentry auth token |
| `sentry_org` | ❌ | — | Sentry organization slug |
| `sentry_projects` | ❌ | — | Comma-separated Sentry project slugs |

## Usage example

```yaml
name: Deploy

on:
  push:
    tags:
      - 'v*'

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.version.outputs.value }}
    steps:
      - uses: actions/checkout@v6

      - name: Extract version from tag
        id: version
        run: echo "value=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push my-app
        uses: docker/build-push-action@v5
        with:
          context: ./my-app
          push: true
          tags: ghcr.io/my-org/my-app:${{ steps.version.outputs.value }}
          build-args: RELEASE=my-app@${{ steps.version.outputs.value }}

      - name: Build and push my-worker
        uses: docker/build-push-action@v5
        with:
          context: ./my-worker
          push: true
          tags: ghcr.io/my-org/my-worker:${{ steps.version.outputs.value }}
          build-args: RELEASE=my-worker@${{ steps.version.outputs.value }}

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - uses: Spryx-AI/spryx-deploy-action@v1
        with:
          services: |
            [
              { "serviceId": "srv_abc123", "image": "ghcr.io/my-org/my-app:${{ needs.build-and-push.outputs.version }}" },
              { "serviceId": "srv_def456", "image": "ghcr.io/my-org/my-worker:${{ needs.build-and-push.outputs.version }}" }
            ]
          environment_id: env_xyz789
          environment: production
          railway_token: ${{ secrets.RAILWAY_TOKEN }}
          release_name: my-app@${{ needs.build-and-push.outputs.version }}
          deploy_wait_timeout_minutes: 15
          sentry_auth_token: ${{ secrets.SENTRY_AUTH_TOKEN }}
          sentry_org: my-org
          sentry_projects: my-app,my-worker
```

## Required secrets

| Secret | Description |
|---|---|
| `RAILWAY_TOKEN` | Railway workspace token |
| `SENTRY_AUTH_TOKEN` | Sentry auth token (only needed if using Sentry tracking) |
