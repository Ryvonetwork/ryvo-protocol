//! Agon protocol error codes.
//!
//! Taxonomy for client handling:
//! - **Retriable**: Transient or correctable; retry may succeed (e.g. `WithdrawalLocked`).
//! - **Permanent**: Invalid state/data; retry will fail (e.g. stale commitment).
//! - **User action**: User must act first (e.g. `InsufficientBalance` -> deposit more).

use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    /// User action: Payer balance too low for debit. Deposit or wait for incoming.
    #[msg("Insufficient balance for this operation")]
    InsufficientBalance,
    /// User action: Cancel or wait for existing withdrawal.
    #[msg("A withdrawal is already pending")]
    WithdrawalAlreadyPending,
    /// Permanent: No withdrawal to execute or cancel.
    #[msg("No withdrawal is currently pending")]
    NoWithdrawalPending,
    /// Retriable: Wait until unlock_at.
    #[msg("Unlock timelock has not yet expired")]
    WithdrawalLocked,
    /// Permanent: Zero address or invalid token account.
    #[msg("Invalid withdrawal destination address")]
    InvalidWithdrawalDestination,
    #[msg("Authority cannot be the zero address")]
    InvalidAuthority,
    #[msg("Fee recipient cannot be the zero address")]
    InvalidFeeRecipient,
    #[msg("Invalid inbound channel policy")]
    InvalidInboundChannelPolicy,
    #[msg("Only the program upgrade authority can initialize the protocol")]
    UnauthorizedInitializer,
    #[msg("Fee BPS must be between 3 (0.03%) and 30 (0.3%)")]
    InvalidFeeBps,
    #[msg("Registration fee must be 0 or between 0.001 and 0.01 SOL")]
    InvalidRegistrationFee,
    #[msg("Invalid deposit_for: amounts length must match recipients, max 16")]
    InvalidDepositFor,
    /// Permanent: Amount must be greater than zero.
    #[msg("Amount must be greater than zero")]
    AmountMustBePositive,
    /// Permanent: committed amount must strictly increase (prevents stale replay and nonce burning).
    #[msg("Committed amount must be greater than the previously settled amount")]
    CommitmentAmountMustIncrease,
    /// Permanent: authority check failed.
    #[msg("Invalid authority signature")]
    InvalidAuthoritySignature,
    /// Permanent: Replay - do not retry.
    #[msg("This signature or clearing round has already been used")]
    SignatureAlreadyUsed,
    #[msg("Participant not found")]
    ParticipantNotFound,
    #[msg("Account participant_id does not match message participant_id")]
    AccountIdMismatch,
    #[msg("Invalid payment commitment message format")]
    InvalidCommitmentMessage,
    #[msg("Invalid clearing round message format")]
    InvalidClearingRoundMessage,
    #[msg("Net flow sums do not balance")]
    NetFlowImbalance,
    #[msg("Net position computation overflowed")]
    NetPositionOverflow,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Chain ID is not supported by this deployment configuration")]
    InvalidChainId,
    #[msg("Message domain does not match this deployment")]
    InvalidMessageDomain,
    #[msg("Ed25519 signature verification failed")]
    InvalidSignature,
    #[msg("Invalid BLS public key")]
    InvalidBlsPublicKey,
    #[msg("Invalid BLS aggregate signature")]
    InvalidBlsSignature,
    #[msg("Invalid BLS proof of possession")]
    InvalidBlsProofOfPossession,
    #[msg("Participant inline BLS key is not registered")]
    ParticipantBlsKeyNotFound,
    #[msg("Participant already has a registered BLS key")]
    ParticipantBlsKeyAlreadyRegistered,
    #[msg("BLS key registration does not match the participant")]
    AccountBlsKeyMismatch,
    #[msg("BLS syscall failed or is unavailable on this cluster")]
    BlsSyscallFailed,
    #[msg("CPI calls to settlement instructions are not allowed")]
    CpiNotAllowed,
    #[msg("Invalid Ed25519 instruction data")]
    InvalidEd25519Data,
    #[msg("Channel must be initialized before use - call create_channel first")]
    ChannelNotInitialized,
    /// Permanent: create_channel called when channel already exists.
    #[msg("Channel already exists for this payer-payee pair")]
    ChannelAlreadyExists,
    /// Permanent: Only the payee or authorized settler can submit (prevents payer front-run attack).
    #[msg("Only the payee or authorized settler can submit this payment commitment")]
    UnauthorizedSettler,
    #[msg("Payee consent is required to create this inbound channel")]
    InboundChannelConsentRequired,
    #[msg("Counterparty consent is required for cooperative channel unlock")]
    CounterpartyConsentRequired,
    #[msg("This participant does not accept inbound channels")]
    InboundChannelsDisabled,
    #[msg("Self-channels are not allowed")]
    SelfChannelNotAllowed,
    #[msg("No authority transfer is currently pending")]
    NoPendingAuthorityTransfer,
    #[msg("Only the nominated pending authority can accept this transfer")]
    UnauthorizedPendingAuthority,
    /// User action: Participant has too many different token balances.
    #[msg("Maximum token balances per participant exceeded")]
    TooManyTokenBalances,
    /// Permanent: Token ID not found in registry.
    #[msg("Token ID not registered in token registry")]
    TokenNotFound,
    /// Permanent: Token mint already registered with different ID.
    #[msg("Token mint already registered")]
    TokenAlreadyRegistered,
    /// Permanent: Token ID already assigned to different mint.
    #[msg("Token ID already in use")]
    TokenIdAlreadyInUse,
    /// Permanent: Only registry authority can register tokens.
    #[msg("Unauthorized token registration")]
    UnauthorizedTokenRegistration,
    /// Permanent: Token ID must be greater than zero.
    #[msg("Token ID must be greater than zero")]
    InvalidTokenId,
    /// Permanent: Token symbol must be valid ASCII.
    #[msg("Token symbol must be valid ASCII")]
    InvalidTokenSymbol,
    /// Permanent: Token decimals exceed the protocol's supported range.
    #[msg("Token decimals exceed the protocol maximum")]
    InvalidTokenDecimals,
    /// Permanent: Token registry account has no remaining capacity.
    #[msg("Token registry account is full")]
    TokenRegistryFull,
    /// Permanent: Token account mint doesn't match registered token.
    #[msg("Token account mint doesn't match registered token")]
    InvalidTokenMint,
    #[msg("Requested unlock amount exceeds the channel's locked balance")]
    InsufficientLockedBalance,
    #[msg("No channel unlock is currently pending")]
    NoChannelUnlockPending,
    #[msg("Authorized signer cannot be the zero address or the current signer")]
    InvalidAuthorizedSigner,
    #[msg("No authorized signer update is currently pending")]
    NoAuthorizedSignerUpdatePending,
    #[msg("Bucket account does not match the expected bucket id or PDA")]
    BucketAccountMismatch,
    #[msg("Bucket slot does not match the expected logical row")]
    BucketSlotMismatch,
    #[msg("Bucket slot is already initialized")]
    BucketSlotAlreadyInitialized,
    #[msg("Bucket has no remaining free slots")]
    BucketFull,
    #[msg("Owner is already registered")]
    OwnerAlreadyRegistered,
    /// Permanent: Plain deposit/withdraw cannot operate on a yield-bearing token id.
    /// Use `deposit_yield_bearing` / `request_withdrawal_yield_bearing` instead.
    #[msg("Token id is yield-bearing; use the yield-bearing instruction variant")]
    TokenIsYieldBearing,
    /// Permanent: yield-bearing instruction was called with a plain token id.
    #[msg("Token id is plain; use the plain deposit/withdrawal instruction")]
    TokenIsNotYieldBearing,
    /// Permanent: provided YieldStrategy account does not match the token id or its stored fields
    /// (mint / reserve / share_mint / share_vault) drift from the registered config.
    #[msg("YieldStrategy account does not match the registered token configuration")]
    InvalidYieldStrategy,
    /// User action: fee_recipient asked to claim more than `protocol_owed_underlying`. Wait for
    /// more yield to accrue or claim a smaller amount.
    #[msg("Requested protocol yield claim exceeds accrued protocol yield")]
    InsufficientProtocolYield,
    /// Permanent: the YieldStrategy's underlying mint does not match the mock-yield Reserve's
    /// underlying mint.
    #[msg("Yield-bearing underlying mint does not match the lending reserve")]
    YieldUnderlyingMismatch,
    /// Permanent: protocol's solvency invariant would be broken by this transaction. This should
    /// only fire if mock-yield account state has drifted from the strategy's tracking; bug in
    /// the protocol if it ever fires in production.
    #[msg("Solvency invariant violated: share_vault USDC value < user_owed + protocol_owed")]
    SolvencyInvariantBroken,
    /// Permanent: provided yield/lending program does not match the strategy's `yield_program`.
    #[msg("Yield program account does not match strategy.yield_program")]
    InvalidYieldProgram,
    /// Permanent: protocol_yield_share_bps exceeded the protocol-imposed cap.
    #[msg("Protocol yield share bps exceeds the maximum allowed value")]
    InvalidProtocolYieldShareBps,
}
