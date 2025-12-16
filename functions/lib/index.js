"use strict";
/**
 * Firebase Cloud Functions for Utility Billing
 *
 * Handles:
 * - Email sending (invoices, reminders, notifications)
 * - Gmail OAuth flow
 * - Scheduled reminder checks
 * - Trigger scraper endpoint
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.triggerScraperManual = exports.triggerScraper = exports.sendReminders = exports.sendAllInvoices = exports.sendInvoiceEmail = exports.disconnectGmail = exports.gmailOAuthCallback = exports.getGmailAuthUrl = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const googleapis_1 = require("googleapis");
const nodemailer = __importStar(require("nodemailer"));
admin.initializeApp();
const db = admin.firestore();
// ========================================
// Gmail OAuth Flow
// ========================================
const GMAIL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/userinfo.email",
];
// Get OAuth2 client for Gmail
function getOAuth2Client(redirectUri) {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error("Gmail OAuth credentials not configured");
    }
    return new googleapis_1.google.auth.OAuth2(clientId, clientSecret, redirectUri ||
        `https://us-central1-utilitysplitter.cloudfunctions.net/gmailOAuthCallback`);
}
// Cloud Function: Get Gmail OAuth authorization URL
exports.getGmailAuthUrl = functions.https.onCall(async (_data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Must be authenticated");
    }
    try {
        const oauth2Client = getOAuth2Client();
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: "offline",
            scope: GMAIL_SCOPES,
            prompt: "consent", // Force consent to always get refresh token
            state: context.auth.uid, // Pass user ID in state for verification
        });
        return { authUrl };
    }
    catch (error) {
        console.error("Error generating auth URL:", error);
        throw new functions.https.HttpsError("internal", "Failed to generate authorization URL");
    }
});
// Cloud Function: Handle Gmail OAuth callback (HTTP endpoint)
exports.gmailOAuthCallback = functions.https.onRequest(async (req, res) => {
    const { code, state, error } = req.query;
    // Handle error from Google
    if (error) {
        console.error("OAuth error:", error);
        res.redirect(`https://utilitysplitter.web.app/settings?gmail_error=${encodeURIComponent(String(error))}`);
        return;
    }
    if (!code || typeof code !== "string") {
        res.redirect("https://utilitysplitter.web.app/settings?gmail_error=no_code");
        return;
    }
    try {
        const oauth2Client = getOAuth2Client();
        const { tokens } = await oauth2Client.getToken(code);
        if (!tokens.refresh_token) {
            console.error("No refresh token received - user may need to revoke and re-authorize");
            res.redirect("https://utilitysplitter.web.app/settings?gmail_error=no_refresh_token");
            return;
        }
        // Get the user's email from the token
        oauth2Client.setCredentials(tokens);
        const oauth2 = googleapis_1.google.oauth2({ version: "v2", auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        const email = userInfo.data.email;
        if (!email) {
            res.redirect("https://utilitysplitter.web.app/settings?gmail_error=no_email");
            return;
        }
        // Store tokens in Firestore
        await db
            .collection("settings")
            .doc("gmail_token")
            .set({
            email,
            access_token: tokens.access_token || "",
            refresh_token: tokens.refresh_token,
            scope: tokens.scope || GMAIL_SCOPES.join(" "),
            expiry: tokens.expiry_date
                ? admin.firestore.Timestamp.fromMillis(tokens.expiry_date)
                : admin.firestore.Timestamp.fromMillis(Date.now() + 3600000),
            updated_at: admin.firestore.Timestamp.now(),
            authorized_by: state || "unknown", // User ID from state
        });
        console.log(`Gmail OAuth successful for ${email}`);
        res.redirect(`https://utilitysplitter.web.app/settings?gmail_success=true&email=${encodeURIComponent(email)}`);
    }
    catch (err) {
        console.error("Error exchanging code for tokens:", err);
        res.redirect(`https://utilitysplitter.web.app/settings?gmail_error=${encodeURIComponent(String(err))}`);
    }
});
// Cloud Function: Disconnect Gmail (remove tokens)
exports.disconnectGmail = functions.https.onCall(async (_data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Must be authenticated");
    }
    try {
        await db.collection("settings").doc("gmail_token").delete();
        return { success: true };
    }
    catch (error) {
        console.error("Error disconnecting Gmail:", error);
        throw new functions.https.HttpsError("internal", "Failed to disconnect Gmail");
    }
});
// ========================================
// Email Sending
// ========================================
// Get Gmail transporter using stored OAuth tokens
async function getGmailTransporter() {
    try {
        // Get Gmail token from settings
        const tokenDoc = await db.collection("settings").doc("gmail_token").get();
        if (!tokenDoc.exists) {
            console.error("Gmail token not found in settings");
            return null;
        }
        const token = tokenDoc.data();
        // Get OAuth2 client credentials from environment
        const clientId = process.env.GMAIL_CLIENT_ID;
        const clientSecret = process.env.GMAIL_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
            console.error("Gmail OAuth credentials not configured");
            return null;
        }
        const oauth2Client = new googleapis_1.google.auth.OAuth2(clientId, clientSecret, `https://us-central1-utilitysplitter.cloudfunctions.net/gmailOAuthCallback`);
        oauth2Client.setCredentials({
            access_token: token.access_token,
            refresh_token: token.refresh_token,
        });
        // Refresh token if expired
        const now = admin.firestore.Timestamp.now();
        if (token.expiry && token.expiry.toMillis() < now.toMillis()) {
            console.log("Token expired, refreshing...");
            const { credentials } = await oauth2Client.refreshAccessToken();
            // Update stored token
            await db
                .collection("settings")
                .doc("gmail_token")
                .update({
                access_token: credentials.access_token,
                expiry: admin.firestore.Timestamp.fromMillis(credentials.expiry_date || Date.now() + 3600000),
                updated_at: now,
            });
            oauth2Client.setCredentials(credentials);
        }
        const accessToken = await oauth2Client.getAccessToken();
        return nodemailer.createTransport({
            service: "gmail",
            auth: {
                type: "OAuth2",
                user: token.email,
                clientId,
                clientSecret,
                refreshToken: token.refresh_token,
                accessToken: accessToken.token || "",
            },
        });
    }
    catch (error) {
        console.error("Error creating Gmail transporter:", error);
        return null;
    }
}
// Email templates
function generateInvoiceHtml(invoice, billDate) {
    const lineItemsHtml = invoice.line_items
        .map((item) => `<tr><td>${item.description}</td><td>$${item.amount.toFixed(2)}</td></tr>`)
        .join("");
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; }
        .header { background: #2563eb; color: white; padding: 20px; }
        .content { padding: 20px; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
        .total { font-size: 1.2em; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Utility Invoice</h1>
      </div>
      <div class="content">
        <p>Hello ${invoice.unit_name},</p>
        <p>Here is your utility invoice for the billing period ending ${billDate}:</p>

        <table>
          <tr><th>Description</th><th>Amount</th></tr>
          ${lineItemsHtml}
          <tr class="total"><td>Total</td><td>$${invoice.amount.toFixed(2)}</td></tr>
        </table>

        <p>Please submit payment at your earliest convenience.</p>
        <p>Thank you!</p>
      </div>
    </body>
    </html>
  `;
}
function generateReminderHtml(invoice, billDate, daysOverdue) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; }
        .header { background: #dc2626; color: white; padding: 20px; }
        .content { padding: 20px; }
        .amount { font-size: 1.5em; font-weight: bold; color: #dc2626; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Payment Reminder</h1>
      </div>
      <div class="content">
        <p>Hello ${invoice.unit_name},</p>
        <p>This is a friendly reminder that your utility payment is <strong>${daysOverdue} days overdue</strong>.</p>
        <p class="amount">Amount Due: $${invoice.amount.toFixed(2)}</p>
        <p>Please submit payment as soon as possible.</p>
        <p>If you've already paid, please disregard this notice.</p>
        <p>Thank you!</p>
      </div>
    </body>
    </html>
  `;
}
// Cloud Function: Send invoice email
exports.sendInvoiceEmail = functions.https.onCall(async (data, context) => {
    // Verify authentication
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Must be authenticated");
    }
    const { billId, invoiceId } = data;
    if (!billId || !invoiceId) {
        throw new functions.https.HttpsError("invalid-argument", "billId and invoiceId required");
    }
    try {
        // Get bill and invoice data
        const billDoc = await db.collection("bills").doc(billId).get();
        if (!billDoc.exists) {
            throw new functions.https.HttpsError("not-found", "Bill not found");
        }
        const bill = billDoc.data();
        const invoiceDoc = await db
            .collection("bills")
            .doc(billId)
            .collection("invoices")
            .doc(invoiceId)
            .get();
        if (!invoiceDoc.exists) {
            throw new functions.https.HttpsError("not-found", "Invoice not found");
        }
        const invoice = invoiceDoc.data();
        // Get transporter
        const transporter = await getGmailTransporter();
        if (!transporter) {
            throw new functions.https.HttpsError("failed-precondition", "Email not configured");
        }
        // Send email
        const html = generateInvoiceHtml(invoice, bill.bill_date);
        await transporter.sendMail({
            to: invoice.tenant_email,
            subject: `Utility Invoice - ${bill.bill_date}`,
            html,
        });
        // Update invoice status
        await invoiceDoc.ref.update({
            status: "SENT",
            sent_at: admin.firestore.Timestamp.now(),
        });
        console.log(`Invoice sent to ${invoice.tenant_email}`);
        return { success: true };
    }
    catch (error) {
        console.error("Error sending invoice:", error);
        throw new functions.https.HttpsError("internal", "Failed to send invoice");
    }
});
// Cloud Function: Send all invoices for a bill
exports.sendAllInvoices = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Must be authenticated");
    }
    const { billId } = data;
    if (!billId) {
        throw new functions.https.HttpsError("invalid-argument", "billId required");
    }
    try {
        const billDoc = await db.collection("bills").doc(billId).get();
        if (!billDoc.exists) {
            throw new functions.https.HttpsError("not-found", "Bill not found");
        }
        const bill = billDoc.data();
        const invoicesSnapshot = await db
            .collection("bills")
            .doc(billId)
            .collection("invoices")
            .where("status", "==", "DRAFT")
            .get();
        const transporter = await getGmailTransporter();
        if (!transporter) {
            throw new functions.https.HttpsError("failed-precondition", "Email not configured");
        }
        const results = [];
        for (const invoiceDoc of invoicesSnapshot.docs) {
            const invoice = invoiceDoc.data();
            try {
                const html = generateInvoiceHtml(invoice, bill.bill_date);
                await transporter.sendMail({
                    to: invoice.tenant_email,
                    subject: `Utility Invoice - ${bill.bill_date}`,
                    html,
                });
                await invoiceDoc.ref.update({
                    status: "SENT",
                    sent_at: admin.firestore.Timestamp.now(),
                });
                results.push({ id: invoiceDoc.id, success: true });
            }
            catch (error) {
                console.error(`Failed to send to ${invoice.tenant_email}:`, error);
                results.push({
                    id: invoiceDoc.id,
                    success: false,
                    error: String(error),
                });
            }
        }
        // Update bill status
        await billDoc.ref.update({
            status: "INVOICED",
            approved_at: admin.firestore.Timestamp.now(),
            approved_by: context.auth.uid,
        });
        return { success: true, results };
    }
    catch (error) {
        console.error("Error sending invoices:", error);
        throw new functions.https.HttpsError("internal", "Failed to send invoices");
    }
});
// Cloud Function: Check and send payment reminders (scheduled daily)
exports.sendReminders = functions.pubsub
    .schedule("0 9 * * *") // Daily at 9 AM
    .timeZone("America/Los_Angeles")
    .onRun(async () => {
    console.log("Starting reminder check...");
    try {
        // Get settings
        const settingsDoc = await db
            .collection("settings")
            .doc("community")
            .get();
        const settings = settingsDoc.exists
            ? settingsDoc.data()
            : { reminder_days: [7, 14] };
        const reminderDays = settings?.reminder_days || [7, 14];
        // Get all INVOICED bills
        const billsSnapshot = await db
            .collection("bills")
            .where("status", "==", "INVOICED")
            .get();
        const transporter = await getGmailTransporter();
        if (!transporter) {
            console.error("Email not configured, skipping reminders");
            return null;
        }
        let remindersSent = 0;
        for (const billDoc of billsSnapshot.docs) {
            const bill = billDoc.data();
            // Get unpaid invoices
            const invoicesSnapshot = await billDoc.ref
                .collection("invoices")
                .where("status", "==", "SENT")
                .get();
            for (const invoiceDoc of invoicesSnapshot.docs) {
                const invoice = invoiceDoc.data();
                if (!invoice.sent_at)
                    continue;
                // Calculate days since sent
                const sentDate = invoice.sent_at.toDate();
                const daysSinceSent = Math.floor((Date.now() - sentDate.getTime()) / (1000 * 60 * 60 * 24));
                // Check if we should send a reminder
                for (let i = 0; i < reminderDays.length; i++) {
                    const reminderDay = reminderDays[i];
                    if (daysSinceSent === reminderDay && invoice.reminders_sent <= i) {
                        // Send reminder
                        const html = generateReminderHtml(invoice, bill.bill_date, daysSinceSent);
                        await transporter.sendMail({
                            to: invoice.tenant_email,
                            subject: `Payment Reminder - Utility Invoice ${bill.bill_date}`,
                            html,
                        });
                        await invoiceDoc.ref.update({
                            reminders_sent: invoice.reminders_sent + 1,
                        });
                        remindersSent++;
                        console.log(`Reminder sent to ${invoice.tenant_email} (${daysSinceSent} days)`);
                        break;
                    }
                }
            }
        }
        console.log(`Reminder check complete: ${remindersSent} reminders sent`);
        return null;
    }
    catch (error) {
        console.error("Error sending reminders:", error);
        return null;
    }
});
// ========================================
// Scraper Functions
// ========================================
// Cloud Function: Trigger scraper (scheduled every 3 days)
exports.triggerScraper = functions.pubsub
    .schedule("0 6 */3 * *") // Every 3 days at 6 AM
    .timeZone("America/Los_Angeles")
    .onRun(async () => {
    console.log("Triggering scraper...");
    try {
        // Get scraper URL from settings or environment
        const scraperUrl = process.env.SCRAPER_URL;
        if (!scraperUrl) {
            console.error("SCRAPER_URL not configured");
            return null;
        }
        // Call the scraper endpoint
        const response = await fetch(scraperUrl + "/scrape", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ type: "all" }),
        });
        if (!response.ok) {
            throw new Error(`Scraper returned ${response.status}`);
        }
        const result = await response.json();
        console.log("Scraper result:", result);
        return null;
    }
    catch (error) {
        console.error("Error triggering scraper:", error);
        return null;
    }
});
// Cloud Function: Manual scraper trigger (callable)
// Increased timeout to 540 seconds (9 min) to accommodate scraper which can take 2-3 minutes
exports.triggerScraperManual = functions
    .runWith({
    timeoutSeconds: 540, // 9 minutes (max allowed)
    memory: "256MB",
})
    .https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Must be authenticated");
    }
    const scraperUrl = process.env.SCRAPER_URL;
    if (!scraperUrl) {
        throw new functions.https.HttpsError("failed-precondition", "Scraper not configured");
    }
    // Update status to running
    await db.collection("settings").doc("scraper_status").set({
        status: "running",
        started_at: admin.firestore.Timestamp.now(),
        triggered_by: context.auth.uid,
    });
    try {
        const response = await fetch(scraperUrl + "/scrape", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ type: data.type || "all" }),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Scraper returned ${response.status}: ${errorText}`);
        }
        const result = await response.json();
        // Update status to completed
        await db
            .collection("settings")
            .doc("scraper_status")
            .set({
            status: "completed",
            started_at: admin.firestore.Timestamp.now(),
            completed_at: admin.firestore.Timestamp.now(),
            result: {
                new_bills: result.seattle_utilities?.new_bills?.length || 0,
                total_checked: result.seattle_utilities?.total_checked || 0,
            },
        });
        return result;
    }
    catch (error) {
        console.error("Error triggering scraper:", error);
        // Update status to error
        await db
            .collection("settings")
            .doc("scraper_status")
            .set({
            status: "error",
            started_at: admin.firestore.Timestamp.now(),
            completed_at: admin.firestore.Timestamp.now(),
            error: error instanceof Error ? error.message : String(error),
        });
        throw new functions.https.HttpsError("internal", "Failed to trigger scraper");
    }
});
//# sourceMappingURL=index.js.map