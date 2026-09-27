import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import {
  type Accounts,
  CHALLENGE_MS,
  type ChallengePurpose,
} from "./accounts.ts";
import type { Config } from "./config.ts";
import { canonicalJson } from "./ids.ts";
import type { Responder } from "./store.ts";

export type Verified =
  | { ok: true; passkeyId: string; binding: unknown }
  | { ok: false; message: string };

const TRANSPORTS = new Set<string>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

function transports(list: readonly string[]): AuthenticatorTransport[] {
  return list.filter((t): t is AuthenticatorTransport => TRANSPORTS.has(t));
}

/** The challenge a browser signed, read from its clientDataJSON. */
function signedChallenge(response: unknown): string | null {
  if (
    typeof response !== "object" ||
    response === null ||
    !("response" in response)
  )
    return null;
  const inner = response.response;
  if (
    typeof inner !== "object" ||
    inner === null ||
    !("clientDataJSON" in inner)
  )
    return null;
  if (typeof inner.clientDataJSON !== "string") return null;
  try {
    return decodeClientDataJSON(inner.clientDataJSON).challenge;
  } catch {
    return null;
  }
}

function credentialId(response: unknown): string | null {
  return typeof response === "object" &&
    response !== null &&
    "id" in response &&
    typeof response.id === "string"
    ? response.id
    : null;
}

/**
 * Passkey step-up for approvals and passkey registration. Every challenge is
 * stored with what it permits and consumed on first use.
 */
export class Passkeys {
  constructor(
    private readonly accounts: Accounts,
    private readonly config: Config,
  ) {}

  /** Options for an assertion bound to `binding`, or `null` if the person has no passkey. */
  async assertionOptions(
    who: Responder,
    purpose: Extract<ChallengePurpose, "answer" | "step_up">,
    binding: unknown,
    now: number,
  ): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
    const keys = await this.accounts.passkeys(who.githubId);
    if (keys.length === 0) return null;
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      allowCredentials: keys.map((k) => ({
        id: k.id,
        transports: transports(k.transports),
      })),
      userVerification: "required",
      timeout: CHALLENGE_MS,
    });
    await this.accounts.createChallenge(
      who.githubId,
      purpose,
      options.challenge,
      binding,
      now,
    );
    return options;
  }

  /**
   * Verifies an assertion against one of the person's passkeys and consumes its
   * challenge. The caller checks the returned binding.
   */
  async verifyAssertion(
    who: Responder,
    purpose: Extract<ChallengePurpose, "answer" | "step_up">,
    assertion: unknown,
    now: number,
  ): Promise<Verified> {
    const challenge = signedChallenge(assertion);
    const id = credentialId(assertion);
    if (!challenge || !id)
      return { ok: false, message: "The passkey response is malformed." };
    const consumed = await this.accounts.consumeChallenge(
      who.githubId,
      purpose,
      challenge,
      now,
    );
    if (!consumed)
      return {
        ok: false,
        message: "The passkey challenge expired or was already used.",
      };
    const key = await this.accounts.passkey(who.githubId, id);
    if (!key)
      return { ok: false, message: "That passkey is not registered to you." };
    try {
      const result = await verifyAuthenticationResponse({
        response: assertion as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        credential: {
          id: key.id,
          publicKey: key.publicKey,
          counter: key.counter,
          transports: transports(key.transports),
        },
        requireUserVerification: true,
      });
      if (!result.verified)
        return { ok: false, message: "The passkey assertion did not verify." };
      await this.accounts.usePasskey(
        who.githubId,
        key.id,
        result.authenticationInfo.newCounter,
        now,
      );
      return { ok: true, passkeyId: key.id, binding: consumed.binding };
    } catch {
      return { ok: false, message: "The passkey assertion did not verify." };
    }
  }

  /**
   * Options to register a passkey. A person who already has one must also
   * sign a step-up assertion, so a session alone cannot add an approving key.
   */
  async registrationOptions(
    who: Responder,
    now: number,
  ): Promise<{
    registration: PublicKeyCredentialCreationOptionsJSON;
    stepUp: PublicKeyCredentialRequestOptionsJSON | null;
  }> {
    const keys = await this.accounts.passkeys(who.githubId);
    const registration = await generateRegistrationOptions({
      rpName: "Roger",
      rpID: this.config.rpId,
      userName: who.login,
      userID: Uint8Array.from(new TextEncoder().encode(String(who.githubId))),
      attestationType: "none",
      excludeCredentials: keys.map((k) => ({
        id: k.id,
        transports: transports(k.transports),
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      timeout: CHALLENGE_MS,
    });
    await this.accounts.createChallenge(
      who.githubId,
      "register",
      registration.challenge,
      {},
      now,
    );
    const stepUp = await this.assertionOptions(
      who,
      "step_up",
      { register: registration.challenge },
      now,
    );
    return { registration, stepUp };
  }

  async register(
    who: Responder,
    registration: unknown,
    stepUp: unknown,
    now: number,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const challenge = signedChallenge(registration);
    if (!challenge)
      return { ok: false, message: "The registration response is malformed." };
    if ((await this.accounts.passkeys(who.githubId)).length > 0) {
      const verified = await this.verifyAssertion(who, "step_up", stepUp, now);
      if (!verified.ok) return verified;
      if (
        canonicalJson(verified.binding) !==
        canonicalJson({ register: challenge })
      )
        return {
          ok: false,
          message: "The step-up assertion was made for another registration.",
        };
    }
    if (
      !(await this.accounts.consumeChallenge(
        who.githubId,
        "register",
        challenge,
        now,
      ))
    )
      return {
        ok: false,
        message: "The registration challenge expired or was already used.",
      };
    try {
      const result = await verifyRegistrationResponse({
        response: registration as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
      });
      if (!result.verified)
        return { ok: false, message: "The registration did not verify." };
      const { credential } = result.registrationInfo;
      await this.accounts.addPasskey(who.githubId, {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
        createdAt: now,
      });
      return { ok: true };
    } catch {
      return { ok: false, message: "The registration did not verify." };
    }
  }
}
