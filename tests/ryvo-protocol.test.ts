// Main test runner that imports all test suites in correct execution order
import "./shared/setup";

// Protocol setup and configuration tests
import "./protocol.test";

// User management tests
import "./participants.test";

// Core functionality tests
import "./deposits.test";
import "./withdrawals.test";

// Cooperative clearing-round tests
import "./clearing-rounds.test";

// Channel management tests
import "./channels.test";

// Settlement tests
import "./settlements.test";
import "./message-v4.test";

// Error condition tests (tests that are expected to fail)
import "./errors.test";

// Edge case tests
import "./edge-cases.test";

// Business logic edge cases
import "./business-logic.test";
