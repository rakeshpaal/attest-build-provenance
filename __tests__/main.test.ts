import * as core from '@actions/core'
import * as jose from 'jose'
import nock from 'nock'
import * as main from '../src/main'

// Mock the GitHub Actions core library functions
const setOutputMock = jest.spyOn(core, 'setOutput')
const setFailedMock = jest.spyOn(core, 'setFailed')

// Ensure that setFailed doesn't set an exit code during tests
setFailedMock.mockImplementation(() => {})

// Shared constants used across all test scenarios
const AUDIENCE = 'nobody'
const JWKS_PATH = '/.well-known/jwks.json'
const TOKEN_PATH = '/token'
const KID = '12345'

// Base claims shared across all test scenarios
const BASE_CLAIMS = {
  aud: AUDIENCE,
  repository: 'owner/repo',
  ref: 'refs/heads/main',
  sha: 'babca52ab0c93ae16539e5923cb0d7403b9a093b',
  workflow_ref: 'owner/repo/.github/workflows/main.yml@main',
  job_workflow_ref: 'owner/shared/.github/workflows/build.yml@main',
  event_name: 'push',
  repository_id: 'repo-id',
  repository_owner_id: 'owner-id',
  run_id: 'run-id',
  run_attempt: 'run-attempt',
  runner_environment: 'github-hosted'
}

interface TestConfig {
  issuer: string
  serverUrl: string
}

/**
 * Sets up OIDC mocks for a given issuer configuration.
 * Reuses the provided key pair to avoid expensive key generation per test.
 */
async function setupOIDCMocks(
  config: TestConfig,
  keyPair: jose.GenerateKeyPairResult<jose.KeyLike>,
  originalEnv: NodeJS.ProcessEnv
): Promise<void> {
  const { issuer, serverUrl } = config
  const claims = { ...BASE_CLAIMS, iss: issuer }

  process.env = {
    ...originalEnv,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${issuer}${TOKEN_PATH}?`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token',
    GITHUB_SERVER_URL: serverUrl,
    GITHUB_REPOSITORY: claims.repository
  }

  // Create JWK, JWKS, and JWT using the shared key pair
  const jwk = await jose.exportJWK(keyPair.publicKey)
  const jwks = { keys: [{ ...jwk, kid: KID }] }
  const jwt = await new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'PS256', kid: KID })
    .sign(keyPair.privateKey)

  // Mock OpenID configuration and JWKS endpoints
  nock(issuer)
    .get('/.well-known/openid-configuration')
    .reply(200, { jwks_uri: `${issuer}${JWKS_PATH}` })
  nock(issuer).get(JWKS_PATH).reply(200, jwks)

  // Mock OIDC token endpoint for populating the provenance
  nock(issuer)
    .get(TOKEN_PATH)
    .query({ audience: AUDIENCE })
    .reply(200, { value: jwt })
}

describe('main', () => {
  let outputs = {} as Record<string, string>
  let keyPair: jose.GenerateKeyPairResult<jose.KeyLike>
  const originalEnv = process.env

  // Generate the key pair once for all tests to improve performance
  beforeAll(async () => {
    keyPair = await jose.generateKeyPair('PS256')
  })

  beforeEach(() => {
    jest.resetAllMocks()

    setOutputMock.mockImplementation((key, value) => {
      outputs[key] = value
    })
  })

  afterEach(() => {
    outputs = {}
    process.env = originalEnv
  })

  describe('when the default OIDC issuer is used', () => {
    const config: TestConfig = {
      issuer: 'https://token.actions.githubusercontent.com',
      serverUrl: 'https://github.com'
    }

    beforeEach(async () => {
      await setupOIDCMocks(config, keyPair, originalEnv)
    })

    it('successfully run main', async () => {
      await main.run()

      expect(setOutputMock).toHaveBeenCalledTimes(2)
      expect(outputs['predicate']).toMatchSnapshot()
      expect(outputs['predicate-type']).toBe('https://slsa.dev/provenance/v1')
    })
  })

  describe('when a non-default OIDC issuer is used', () => {
    const config: TestConfig = {
      issuer: 'https://token.actions.example-01.ghe.com',
      serverUrl: 'https://example-01.ghe.com'
    }

    beforeEach(async () => {
      await setupOIDCMocks(config, keyPair, originalEnv)
    })

    it('successfully run main', async () => {
      await main.run()

      expect(setOutputMock).toHaveBeenCalledTimes(2)
      expect(outputs['predicate']).toMatchSnapshot()
      expect(outputs['predicate-type']).toBe('https://slsa.dev/provenance/v1')
    })
  })
})
