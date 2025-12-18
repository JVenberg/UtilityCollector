/**
 * Firebase Cloud Functions for Utility Billing
 *
 * Handles:
 * - Email sending (invoices, reminders, notifications)
 * - Gmail OAuth flow
 * - Scheduled reminder checks
 * - Trigger scraper endpoint
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { google } from "googleapis";
import * as nodemailer from "nodemailer";

admin.initializeApp();

const db = admin.firestore();

// Types
type LineItemCategory =
  | "water_usage"
  | "water_sqft"
  | "sewer"
  | "drainage"
  | "solid_waste"
  | "adjustment";

interface LineItem {
  description: string;
  amount: number;
  category?: LineItemCategory;
}

interface Invoice {
  unit_id: string;
  unit_name: string;
  tenant_email: string;
  amount: number;
  line_items: LineItem[];
  status: "DRAFT" | "SENT" | "PAID";
  sent_at: admin.firestore.Timestamp | null;
  reminders_sent: number;
}

interface GmailToken {
  access_token: string;
  refresh_token: string;
  scope: string;
  expiry: admin.firestore.Timestamp;
  email: string;
}

// ========================================
// Gmail OAuth Flow
// ========================================

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

// Get OAuth2 client for Gmail
function getOAuth2Client(redirectUri?: string) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Gmail OAuth credentials not configured");
  }

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri ||
      `https://us-central1-utilitysplitter.cloudfunctions.net/gmailOAuthCallback`
  );
}

// Cloud Function: Get Gmail OAuth authorization URL
export const getGmailAuthUrl = functions.https.onCall(
  async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be authenticated"
      );
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
    } catch (error) {
      console.error("Error generating auth URL:", error);
      throw new functions.https.HttpsError(
        "internal",
        "Failed to generate authorization URL"
      );
    }
  }
);

// Cloud Function: Handle Gmail OAuth callback (HTTP endpoint)
export const gmailOAuthCallback = functions.https.onRequest(
  async (req, res) => {
    const { code, state, error } = req.query;

    // Handle error from Google
    if (error) {
      console.error("OAuth error:", error);
      res.redirect(
        `https://utilitysplitter.web.app/settings?gmail_error=${encodeURIComponent(
          String(error)
        )}`
      );
      return;
    }

    if (!code || typeof code !== "string") {
      res.redirect(
        "https://utilitysplitter.web.app/settings?gmail_error=no_code"
      );
      return;
    }

    try {
      const oauth2Client = getOAuth2Client();
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.refresh_token) {
        console.error(
          "No refresh token received - user may need to revoke and re-authorize"
        );
        res.redirect(
          "https://utilitysplitter.web.app/settings?gmail_error=no_refresh_token"
        );
        return;
      }

      // Get the user's email from the token
      oauth2Client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      const email = userInfo.data.email;

      if (!email) {
        res.redirect(
          "https://utilitysplitter.web.app/settings?gmail_error=no_email"
        );
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
      res.redirect(
        `https://utilitysplitter.web.app/settings?gmail_success=true&email=${encodeURIComponent(
          email
        )}`
      );
    } catch (err) {
      console.error("Error exchanging code for tokens:", err);
      res.redirect(
        `https://utilitysplitter.web.app/settings?gmail_error=${encodeURIComponent(
          String(err)
        )}`
      );
    }
  }
);

// Cloud Function: Disconnect Gmail (remove tokens)
export const disconnectGmail = functions.https.onCall(
  async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be authenticated"
      );
    }

    try {
      await db.collection("settings").doc("gmail_token").delete();
      return { success: true };
    } catch (error) {
      console.error("Error disconnecting Gmail:", error);
      throw new functions.https.HttpsError(
        "internal",
        "Failed to disconnect Gmail"
      );
    }
  }
);

// ========================================
// Email Sending
// ========================================

// Get Gmail transporter using stored OAuth tokens
async function getGmailTransporter(): Promise<nodemailer.Transporter | null> {
  try {
    // Get Gmail token from settings
    const tokenDoc = await db.collection("settings").doc("gmail_token").get();
    if (!tokenDoc.exists) {
      console.error("Gmail token not found in settings");
      return null;
    }

    const token = tokenDoc.data() as GmailToken;

    // Get OAuth2 client credentials from environment
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error("Gmail OAuth credentials not configured");
      return null;
    }

    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      `https://us-central1-utilitysplitter.cloudfunctions.net/gmailOAuthCallback`
    );

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
          expiry: admin.firestore.Timestamp.fromMillis(
            credentials.expiry_date || Date.now() + 3600000
          ),
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
  } catch (error) {
    console.error("Error creating Gmail transporter:", error);
    return null;
  }
}

// Email templates - Category configuration matching frontend (BillDetail.tsx)
const CATEGORY_CONFIG: {
  key: LineItemCategory;
  label: string;
  color: string;
  bgColor: string;
}[] = [
  { key: "water_usage", label: "Water (by usage)", color: "#2563EB", bgColor: "#EFF6FF" },
  { key: "water_sqft", label: "Water (by sqft)", color: "#3B82F6", bgColor: "#EFF6FF" },
  { key: "sewer", label: "Sewer", color: "#7C3AED", bgColor: "#F5F3FF" },
  { key: "drainage", label: "Drainage", color: "#0D9488", bgColor: "#F0FDFA" },
  { key: "solid_waste", label: "Solid Waste", color: "#16A34A", bgColor: "#F0FDF4" },
  { key: "adjustment", label: "Adjustments", color: "#EA580C", bgColor: "#FFF7ED" },
];

function generateInvoiceHtml(invoice: Invoice, billDate: string): string {
  // Group line items by category (matching frontend logic)
  const grouped = new Map<string, LineItem[]>();
  for (const item of invoice.line_items) {
    const cat = item.category || "other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(item);
  }

  // Generate HTML for each category section
  let categorySectionsHtml = "";
  for (const { key, label, color, bgColor } of CATEGORY_CONFIG) {
    const items = grouped.get(key);
    if (!items || items.length === 0) continue;

    const categoryTotal = items.reduce((sum, i) => sum + i.amount, 0);

    // Generate individual line items for this category
    const itemsHtml = items
      .map(
        (item) => `
        <tr>
          <td style="padding: 8px 12px 8px 24px; color: #4B5563; font-size: 14px;">
            ${item.description.replace(/^(Water|Sewer|Drainage): /, "")}
          </td>
          <td style="padding: 8px 12px; text-align: right; color: #4B5563; font-size: 14px;">
            $${item.amount.toFixed(2)}
          </td>
        </tr>
      `
      )
      .join("");

    // Category header row with subtotal
    categorySectionsHtml += `
      <tr style="background-color: ${bgColor};">
        <td style="padding: 12px; font-weight: 600; color: ${color}; font-size: 15px; border-top: 1px solid #E5E7EB;">
          ${label}
        </td>
        <td style="padding: 12px; text-align: right; font-weight: 600; color: ${color}; font-size: 15px; border-top: 1px solid #E5E7EB;">
          $${categoryTotal.toFixed(2)}
        </td>
      </tr>
      ${itemsHtml}
    `;
  }

  // Handle any uncategorized items (shouldn't happen but safety fallback)
  const otherItems = grouped.get("other");
  if (otherItems && otherItems.length > 0) {
    const otherTotal = otherItems.reduce((sum, i) => sum + i.amount, 0);
    const otherItemsHtml = otherItems
      .map(
        (item) => `
        <tr>
          <td style="padding: 8px 12px 8px 24px; color: #4B5563; font-size: 14px;">
            ${item.description}
          </td>
          <td style="padding: 8px 12px; text-align: right; color: #4B5563; font-size: 14px;">
            $${item.amount.toFixed(2)}
          </td>
        </tr>
      `
      )
      .join("");

    categorySectionsHtml += `
      <tr style="background-color: #F9FAFB;">
        <td style="padding: 12px; font-weight: 600; color: #6B7280; font-size: 15px; border-top: 1px solid #E5E7EB;">
          Other Charges
        </td>
        <td style="padding: 12px; text-align: right; font-weight: 600; color: #6B7280; font-size: 15px; border-top: 1px solid #E5E7EB;">
          $${otherTotal.toFixed(2)}
        </td>
      </tr>
      ${otherItemsHtml}
    `;
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Utility Invoice - ${billDate}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F3F4F6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td style="padding: 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td colspan="2" style="background-color: #2563EB; padding: 24px; text-align: center;">
              <h1 style="margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 600;">Utility Invoice</h1>
            </td>
          </tr>
          
          <!-- Bill Info -->
          <tr>
            <td colspan="2" style="padding: 24px 24px 16px 24px;">
              <p style="margin: 0 0 8px 0; color: #374151; font-size: 16px;">Hello <strong>${invoice.unit_name}</strong>,</p>
              <p style="margin: 0; color: #6B7280; font-size: 14px;">Here is your utility invoice for the billing period ending <strong>${billDate}</strong>:</p>
            </td>
          </tr>
          
          <!-- Invoice Details Table -->
          <tr>
            <td colspan="2" style="padding: 0 24px;">
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                ${categorySectionsHtml}
                
                <!-- Total Row -->
                <tr style="background-color: #1F2937;">
                  <td style="padding: 16px; font-weight: 700; color: #FFFFFF; font-size: 18px; border-top: 2px solid #E5E7EB;">
                    Total Due
                  </td>
                  <td style="padding: 16px; text-align: right; font-weight: 700; color: #FFFFFF; font-size: 18px; border-top: 2px solid #E5E7EB;">
                    $${invoice.amount.toFixed(2)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td colspan="2" style="padding: 24px;">
              <p style="margin: 0 0 12px 0; color: #374151; font-size: 14px;">Please submit payment at your earliest convenience.</p>
              <p style="margin: 0; color: #6B7280; font-size: 14px;">If you have any questions about this invoice, please contact your property manager.</p>
            </td>
          </tr>
          
          <!-- Footer Bar -->
          <tr>
            <td colspan="2" style="background-color: #F9FAFB; padding: 16px 24px; border-top: 1px solid #E5E7EB;">
              <p style="margin: 0; color: #9CA3AF; font-size: 12px; text-align: center;">Thank you for your prompt payment!</p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

function generateReminderHtml(
  invoice: Invoice,
  billDate: string,
  daysOverdue: number
): string {
  // Determine urgency level based on days overdue
  const isUrgent = daysOverdue >= 14;
  const headerColor = isUrgent ? "#DC2626" : "#F59E0B"; // Red for urgent, amber for first reminder
  const headerBgColor = isUrgent ? "#FEF2F2" : "#FFFBEB";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Reminder - ${billDate}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F3F4F6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td style="padding: 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td colspan="2" style="background-color: ${headerColor}; padding: 24px; text-align: center;">
              <h1 style="margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 600;">Payment Reminder</h1>
            </td>
          </tr>
          
          <!-- Alert Banner -->
          <tr>
            <td colspan="2" style="background-color: ${headerBgColor}; padding: 16px 24px; border-bottom: 1px solid #E5E7EB;">
              <p style="margin: 0; color: ${headerColor}; font-size: 14px; font-weight: 600; text-align: center;">
                ⚠️ Your payment is ${daysOverdue} days overdue
              </p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td colspan="2" style="padding: 24px;">
              <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px;">Hello <strong>${invoice.unit_name}</strong>,</p>
              <p style="margin: 0 0 24px 0; color: #6B7280; font-size: 14px;">
                This is a friendly reminder that your utility payment for the billing period ending <strong>${billDate}</strong> is still outstanding.
              </p>
              
              <!-- Amount Box -->
              <div style="background-color: #F9FAFB; border: 2px solid ${headerColor}; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
                <p style="margin: 0 0 8px 0; color: #6B7280; font-size: 14px;">Amount Due</p>
                <p style="margin: 0; color: ${headerColor}; font-size: 32px; font-weight: 700;">$${invoice.amount.toFixed(2)}</p>
              </div>
              
              <p style="margin: 0 0 12px 0; color: #374151; font-size: 14px;">Please submit payment as soon as possible to avoid any late fees or service interruptions.</p>
              <p style="margin: 0; color: #6B7280; font-size: 14px;">If you've already paid, please disregard this notice. Thank you!</p>
            </td>
          </tr>
          
          <!-- Footer Bar -->
          <tr>
            <td colspan="2" style="background-color: #F9FAFB; padding: 16px 24px; border-top: 1px solid #E5E7EB;">
              <p style="margin: 0; color: #9CA3AF; font-size: 12px; text-align: center;">Questions? Contact your property manager.</p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// Cloud Function: Send invoice email
export const sendInvoiceEmail = functions.https.onCall(
  async (data, context) => {
    // Verify authentication
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be authenticated"
      );
    }

    const { billId, invoiceId } = data;
    if (!billId || !invoiceId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "billId and invoiceId required"
      );
    }

    try {
      // Get bill and invoice data
      const billDoc = await db.collection("bills").doc(billId).get();
      if (!billDoc.exists) {
        throw new functions.https.HttpsError("not-found", "Bill not found");
      }
      const bill = billDoc.data()!;

      const invoiceDoc = await db
        .collection("bills")
        .doc(billId)
        .collection("invoices")
        .doc(invoiceId)
        .get();
      if (!invoiceDoc.exists) {
        throw new functions.https.HttpsError("not-found", "Invoice not found");
      }
      const invoice = invoiceDoc.data() as Invoice;

      // Get transporter
      const transporter = await getGmailTransporter();
      if (!transporter) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Email not configured"
        );
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
    } catch (error) {
      console.error("Error sending invoice:", error);
      throw new functions.https.HttpsError(
        "internal",
        "Failed to send invoice"
      );
    }
  }
);

// Cloud Function: Send all invoices for a bill
export const sendAllInvoices = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be authenticated"
    );
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
    const bill = billDoc.data()!;

    const invoicesSnapshot = await db
      .collection("bills")
      .doc(billId)
      .collection("invoices")
      .where("status", "==", "DRAFT")
      .get();

    const transporter = await getGmailTransporter();
    if (!transporter) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Email not configured"
      );
    }

    const results = [];
    for (const invoiceDoc of invoicesSnapshot.docs) {
      const invoice = invoiceDoc.data() as Invoice;
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
      } catch (error) {
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
  } catch (error) {
    console.error("Error sending invoices:", error);
    throw new functions.https.HttpsError("internal", "Failed to send invoices");
  }
});

// Cloud Function: Check and send payment reminders (scheduled daily)
export const sendReminders = functions.pubsub
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
      const reminderDays: number[] = settings?.reminder_days || [7, 14];

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
          const invoice = invoiceDoc.data() as Invoice;

          if (!invoice.sent_at) continue;

          // Calculate days since sent
          const sentDate = invoice.sent_at.toDate();
          const daysSinceSent = Math.floor(
            (Date.now() - sentDate.getTime()) / (1000 * 60 * 60 * 24)
          );

          // Check if we should send a reminder
          for (let i = 0; i < reminderDays.length; i++) {
            const reminderDay = reminderDays[i];
            if (daysSinceSent === reminderDay && invoice.reminders_sent <= i) {
              // Send reminder
              const html = generateReminderHtml(
                invoice,
                bill.bill_date,
                daysSinceSent
              );
              await transporter.sendMail({
                to: invoice.tenant_email,
                subject: `Payment Reminder - Utility Invoice ${bill.bill_date}`,
                html,
              });

              await invoiceDoc.ref.update({
                reminders_sent: invoice.reminders_sent + 1,
              });

              remindersSent++;
              console.log(
                `Reminder sent to ${invoice.tenant_email} (${daysSinceSent} days)`
              );
              break;
            }
          }
        }
      }

      console.log(`Reminder check complete: ${remindersSent} reminders sent`);
      return null;
    } catch (error) {
      console.error("Error sending reminders:", error);
      return null;
    }
  });

// ========================================
// Scraper Functions
// ========================================

// Cloud Function: Trigger scraper (scheduled every 3 days)
export const triggerScraper = functions.pubsub
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
    } catch (error) {
      console.error("Error triggering scraper:", error);
      return null;
    }
  });

// Cloud Function: Fetch meter readings for a specific date range
// Used by BillDetail to auto-populate readings for a bill period
export const fetchMeterReadings = functions
  .runWith({
    timeoutSeconds: 120, // 2 minutes should be enough for just readings
    memory: "256MB",
  })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be authenticated"
      );
    }

    const { startDate, endDate } = data;
    if (!startDate || !endDate) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "startDate and endDate required"
      );
    }

    const scraperUrl = process.env.SCRAPER_URL;
    if (!scraperUrl) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Scraper not configured"
      );
    }

    try {
      console.log(`Fetching readings for period: ${startDate} to ${endDate}`);

      const response = await fetch(scraperUrl + "/readings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
        }),
      });

      const result = await response.json();

      // Handle error responses from scraper (including 4xx status codes)
      if (!response.ok || !result.success) {
        const errorMsg = result.error || `Scraper returned ${response.status}`;
        console.error("Scraper error:", errorMsg);
        throw new functions.https.HttpsError("failed-precondition", errorMsg);
      }

      console.log(
        `Got readings for ${Object.keys(result.readings || {}).length} units`
      );

      const returnData: {
        success: boolean;
        readings: Record<string, unknown>;
        unit: string;
        warnings?: string[];
      } = {
        success: true,
        readings: result.readings,
        unit: result.unit || "gallons",
      };

      // Include warnings if present
      if (result.warnings && result.warnings.length > 0) {
        returnData.warnings = result.warnings;
        console.log("Scraper warnings:", result.warnings);
      }

      return returnData;
    } catch (error) {
      console.error("Error fetching readings:", error);
      // Re-throw HttpsError as-is
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      throw new functions.https.HttpsError(
        "internal",
        error instanceof Error ? error.message : "Failed to fetch readings"
      );
    }
  });

// Cloud Function: Manual scraper trigger (callable)
// Increased timeout to 540 seconds (9 min) to accommodate scraper which can take 2-3 minutes
export const triggerScraperManual = functions
  .runWith({
    timeoutSeconds: 540, // 9 minutes (max allowed)
    memory: "256MB",
  })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be authenticated"
      );
    }

    const scraperUrl = process.env.SCRAPER_URL;
    if (!scraperUrl) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Scraper not configured"
      );
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
    } catch (error) {
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

      throw new functions.https.HttpsError(
        "internal",
        "Failed to trigger scraper"
      );
    }
  });
