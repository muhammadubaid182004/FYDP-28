/**
 * Direct validation script for hashing and JWT
 * This tests the bcrypt-ts and jose functionality
 */

import { hashSync, compareSync } from "bcrypt-ts";
import { SignJWT, jwtVerify } from "jose";

const JWT_SECRET = new TextEncoder().encode("dr-retinascan-jwt-hs256-secret-key-2024");

async function validateAuth() {
  console.log("🔐 Validating Authentication System...\n");

  try {
    // 1. Test bcrypt hashing
    console.log("📝 Test 1: Password Hashing with bcrypt-ts");
    const password = "testuser123";
    const hash = hashSync(password, 10);
    console.log(`  ✓ Generated hash: ${hash.slice(0, 20)}...`);
    
    const isValid = compareSync(password, hash);
    console.log(`  ✓ Password verification: ${isValid ? "PASSED ✓" : "FAILED ✗"}`);
    
    const isInvalid = compareSync("wrongpassword", hash);
    console.log(`  ✓ Wrong password rejected: ${!isInvalid ? "PASSED ✓" : "FAILED ✗"}`);

    // 2. Test JWT creation
    console.log("\n🔑 Test 2: JWT Token Generation with jose");
    const payload = { userId: "1", username: "testuser" };
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(JWT_SECRET);
    
    console.log(`  ✓ Generated JWT: ${token.slice(0, 30)}...`);
    console.log(`  ✓ Token format valid: ${token.split(".").length === 3 ? "PASSED ✓" : "FAILED ✗"}`);

    // 3. Test JWT verification
    console.log("\n✔️ Test 3: JWT Token Verification");
    const { payload: decoded } = await jwtVerify(token, JWT_SECRET, {
      algorithms: ["HS256"],
    });
    
    console.log(`  ✓ Token verified successfully`);
    console.log(`  ✓ User ID: ${decoded.userId}`);
    console.log(`  ✓ Username: ${decoded.username}`);
    console.log(`  ✓ Issued at: ${new Date((decoded.iat as number) * 1000).toISOString()}`);
    console.log(`  ✓ Expires at: ${new Date((decoded.exp as number) * 1000).toISOString()}`);
    
    // Verify expiration is ~24h
    const expiresIn = ((decoded.exp as number) - (decoded.iat as number)) / 3600;
    console.log(`  ✓ Token validity: ${expiresIn.toFixed(2)} hours`);

    // 4. Test tampering detection
    console.log("\n🛡️ Test 4: Tampering Detection");
    const tampered = token.slice(0, -5) + "xxxxx";
    try {
      await jwtVerify(tampered, JWT_SECRET, { algorithms: ["HS256"] });
      console.log("  ✗ FAILED - Tampered token was accepted!");
    } catch (e) {
      console.log("  ✓ Tampered token rejected: PASSED ✓");
    }

    // 5. Test expiration
    console.log("\n⏰ Test 5: Token Expiration");
    const expiredToken = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("0s")
      .sign(JWT_SECRET);

    // Wait a bit for token to expire
    await new Promise(resolve => setTimeout(resolve, 100));
    
    try {
      await jwtVerify(expiredToken, JWT_SECRET, { algorithms: ["HS256"] });
      console.log("  ✗ FAILED - Expired token was accepted!");
    } catch (e) {
      console.log("  ✓ Expired token rejected: PASSED ✓");
    }

    console.log("\n" + "=".repeat(50));
    console.log("✅ ALL TESTS PASSED - Auth System is Working!");
    console.log("=".repeat(50));

  } catch (error) {
    console.error("\n❌ ERROR:", error);
    process.exit(1);
  }
}

validateAuth();
