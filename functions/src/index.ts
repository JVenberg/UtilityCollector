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
const storage = admin.storage();

// Base URL for the web app
const WEB_APP_URL = "https://utilitysplitter.web.app";

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

// Email log entry - tracks each email sent for an invoice
interface EmailLogEntry {
  type: "invoice" | "reminder";  // Type of email
  sent_at: admin.firestore.Timestamp;  // When email was sent
  message_id: string | null;  // Gmail message ID (for tracking/proof)
  recipient: string;  // Email address sent to
  success: boolean;  // Whether send was successful
  error?: string;  // Error message if failed
}

interface Invoice {
  unit_id: string;
  unit_name: string;
  tenant_email: string;
  amount: number;
  line_items: LineItem[];
  status: "DRAFT" | "INVOICED" | "PAID";
  paid_at: admin.firestore.Timestamp | null;
  email_log: EmailLogEntry[];
  first_sent_at?: admin.firestore.Timestamp | null;
  reminders_sent?: number;
}

interface GmailToken {
  access_token: string;
  refresh_token: string;
  scope: string;
  expiry: admin.firestore.Timestamp;
  email: string;
}

interface EmailSettings {
  payment_instructions: string; // HTML-enabled instructions for payment
  include_pdf_attachment: boolean; // Whether to attach bill PDF to email
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

// Helper to get authenticated OAuth2 client
async function getAuthenticatedOAuth2Client(): Promise<{
  oauth2Client: InstanceType<typeof google.auth.OAuth2>;
  email: string;
} | null> {
  try {
    // Get Gmail token from settings
    const tokenDoc = await db.collection("settings").doc("gmail_token").get();
    if (!tokenDoc.exists) {
      console.error("Gmail token not found in settings");
      return null;
    }

    const token = tokenDoc.data() as GmailToken;
    console.log(`Gmail token found for: ${token.email}, expiry: ${token.expiry?.toDate?.()}`);

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

    // Set credentials
    oauth2Client.setCredentials({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
    });

    // Check if token is expired and refresh if needed
    const now = admin.firestore.Timestamp.now();
    const isExpired = token.expiry && token.expiry.toMillis() < now.toMillis();
    
    if (isExpired) {
      console.log("Token expired, refreshing...");
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        
        if (!credentials.access_token) {
          console.error("No access token received from refresh");
          throw new Error("Token refresh did not return access token");
        }

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
        console.log("Token refreshed successfully");
      } catch (refreshError) {
        console.error("Failed to refresh token:", refreshError);
        throw new Error("Failed to refresh expired token. Please reconnect Gmail.");
      }
    } else {
      console.log("Token still valid");
    }

    return { oauth2Client, email: token.email };
  } catch (error) {
    console.error("Error getting OAuth2 client:", error);
    return null;
  }
}

// Send email using Gmail API directly (more reliable than SMTP with OAuth)
// Returns the Gmail message ID for tracking/logging
async function sendEmailViaGmailApi(
  to: string,
  subject: string,
  htmlBody: string,
  attachments?: { filename: string; content: Buffer }[]
): Promise<string | null> {
  const authResult = await getAuthenticatedOAuth2Client();
  if (!authResult) {
    throw new Error("Gmail not configured");
  }

  const { oauth2Client, email: fromEmail } = authResult;
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // Build the email
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  
  let emailLines: string[] = [];
  
  if (attachments && attachments.length > 0) {
    // Multipart email with attachments
    emailLines = [
      `From: ${fromEmail}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      Buffer.from(htmlBody).toString("base64"),
    ];

    // Add attachments
    for (const attachment of attachments) {
      emailLines.push(
        `--${boundary}`,
        `Content-Type: application/pdf; name="${attachment.filename}"`,
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        attachment.content.toString("base64")
      );
    }
    
    emailLines.push(`--${boundary}--`);
  } else {
    // Simple HTML email
    emailLines = [
      `From: ${fromEmail}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      Buffer.from(htmlBody).toString("base64"),
    ];
  }

  const rawEmail = emailLines.join("\r\n");
  const encodedEmail = Buffer.from(rawEmail)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  console.log(`Sending email to ${to} via Gmail API...`);
  
  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodedEmail,
    },
  });

  const messageId = response.data.id || null;
  console.log(`Email sent successfully to ${to}, message ID: ${messageId}`);
  return messageId;
}

// Legacy function for backwards compatibility - now uses Gmail API
// Returns a fake transporter that captures the message ID
async function getGmailTransporter(): Promise<{ sendMail: (options: nodemailer.SendMailOptions) => Promise<{ messageId: string | null }> } | null> {
  // Check if Gmail is configured
  const authResult = await getAuthenticatedOAuth2Client();
  if (!authResult) {
    return null;
  }

  // Return a fake transporter that uses Gmail API and returns the message ID
  const fakeTransporter = {
    sendMail: async (options: nodemailer.SendMailOptions): Promise<{ messageId: string | null }> => {
      const messageId = await sendEmailViaGmailApi(
        options.to as string,
        options.subject || "",
        options.html as string || options.text as string || "",
        options.attachments?.map((a) => ({
          filename: (a as { filename?: string }).filename || "attachment",
          content: (a as { content?: Buffer }).content || Buffer.from(""),
        }))
      );
      return { messageId };
    },
  };

  return fakeTransporter;
}

// Email templates - Category configuration (neutral colors for clean email appearance)
const CATEGORY_CONFIG: {
  key: LineItemCategory;
  label: string;
}[] = [
  { key: "water_usage", label: "Water (by usage)" },
  { key: "water_sqft", label: "Water (by sqft)" },
  { key: "sewer", label: "Sewer" },
  { key: "drainage", label: "Drainage" },
  { key: "solid_waste", label: "Solid Waste" },
  { key: "adjustment", label: "Adjustments" },
];

function generateInvoiceHtml(
  invoice: Invoice,
  billDate: string,
  billId: string,
  paymentInstructions?: string
): string {
  // Link to view invoice online
  const onlineViewUrl = `${WEB_APP_URL}/bills/${billId}`;
  
  // Group line items by category (matching frontend logic)
  const grouped = new Map<string, LineItem[]>();
  for (const item of invoice.line_items) {
    const cat = item.category || "other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(item);
  }

  // Generate HTML for each category section
  let categorySectionsHtml = "";
  for (const { key, label } of CATEGORY_CONFIG) {
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

    // Category header row with subtotal (neutral gray styling)
    categorySectionsHtml += `
      <tr style="background-color: #F9FAFB;">
        <td style="padding: 12px; font-weight: 600; color: #374151; font-size: 15px; border-top: 1px solid #E5E7EB;">
          ${label}
        </td>
        <td style="padding: 12px; text-align: right; font-weight: 600; color: #374151; font-size: 15px; border-top: 1px solid #E5E7EB;">
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

  // Generate payment instructions section (if provided)
  const paymentInstructionsHtml = paymentInstructions ? `
    <tr>
      <td colspan="2" style="padding: 0 24px 24px 24px;">
        <div style="background-color: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 8px; padding: 16px;">
          <h3 style="margin: 0 0 12px 0; color: #166534; font-size: 15px; font-weight: 600;">Payment Instructions</h3>
          <div style="color: #374151; font-size: 14px; line-height: 1.6;">
            ${paymentInstructions}
          </div>
        </div>
      </td>
    </tr>
  ` : "";

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
          
          ${paymentInstructionsHtml}
          
          <!-- View Online Link -->
          <tr>
            <td colspan="2" style="padding: 0 24px 24px 24px; text-align: center;">
              <a href="${onlineViewUrl}" style="display: inline-block; background-color: #2563EB; color: #FFFFFF; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">View Invoice Online</a>
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

// Helper function to get PDF attachment from Cloud Storage
async function getPdfAttachment(pdfUrl: string): Promise<{ filename: string; content: Buffer } | null> {
  try {
    // pdfUrl format: gs://bucket/bills/date.pdf or https://storage.googleapis.com/...
    let filePath: string;
    let bucketName: string | undefined;
    
    if (pdfUrl.startsWith("gs://")) {
      // gs://bucket/path/to/file.pdf
      const parts = pdfUrl.replace("gs://", "").split("/");
      bucketName = parts.shift(); // extract bucket name
      filePath = parts.join("/");
      console.log(`Downloading from gs:// - bucket: ${bucketName}, path: ${filePath}`);
    } else if (pdfUrl.includes("storage.googleapis.com")) {
      // https://storage.googleapis.com/bucket/path/to/file.pdf
      const urlParts = new URL(pdfUrl);
      const pathParts = urlParts.pathname.split("/");
      pathParts.shift(); // remove empty string
      bucketName = pathParts.shift(); // extract bucket name
      filePath = pathParts.join("/");
      console.log(`Downloading from storage URL - bucket: ${bucketName}, path: ${filePath}`);
    } else {
      console.warn("Unknown PDF URL format:", pdfUrl);
      return null;
    }

    // Use specified bucket or default
    const bucket = bucketName ? storage.bucket(bucketName) : storage.bucket();
    const file = bucket.file(filePath);
    
    const [exists] = await file.exists();
    if (!exists) {
      console.warn(`PDF file not found: ${filePath} in bucket ${bucketName || 'default'}`);
      return null;
    }

    const [content] = await file.download();
    const filename = filePath.split("/").pop() || "utility-bill.pdf";
    console.log(`Downloaded PDF: ${filename} (${content.length} bytes)`);
    
    return { filename, content };
  } catch (error) {
    console.error("Error downloading PDF:", error);
    return null;
  }
}

// Helper function to get email settings
async function getEmailSettings(): Promise<EmailSettings> {
  try {
    const doc = await db.collection("settings").doc("email").get();
    if (doc.exists) {
      return doc.data() as EmailSettings;
    }
  } catch (error) {
    console.error("Error getting email settings:", error);
  }
  return {
    payment_instructions: "",
    include_pdf_attachment: false,
  };
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

      // Get email settings
      const emailSettings = await getEmailSettings();

      // Get transporter
      const transporter = await getGmailTransporter();
      if (!transporter) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Email not configured"
        );
      }

      // Generate email HTML
      const html = generateInvoiceHtml(
        invoice,
        bill.bill_date,
        billId,
        emailSettings.payment_instructions || undefined
      );

      // Prepare email options
      const mailOptions: nodemailer.SendMailOptions = {
        to: invoice.tenant_email,
        subject: `Utility Invoice - ${bill.bill_date}`,
        html,
      };

      // Add PDF attachment if enabled and available
      if (emailSettings.include_pdf_attachment && bill.pdf_url) {
        const attachment = await getPdfAttachment(bill.pdf_url);
        if (attachment) {
          mailOptions.attachments = [{
            filename: attachment.filename,
            content: attachment.content,
          }];
        }
      }

      const result = await transporter.sendMail(mailOptions);
      const now = admin.firestore.Timestamp.now();

      // Create email log entry
      const emailLogEntry: EmailLogEntry = {
        type: "invoice",
        sent_at: now,
        message_id: result.messageId,
        recipient: invoice.tenant_email,
        success: true,
      };

      // Update invoice with email log
      await invoiceDoc.ref.update({
        status: "INVOICED",
        email_log: admin.firestore.FieldValue.arrayUnion(emailLogEntry),
        first_sent_at: invoice.first_sent_at || now,
      });

      console.log(`Invoice sent to ${invoice.tenant_email}, message ID: ${result.messageId}`);
      return { success: true, messageId: result.messageId };
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

    // Get email settings
    const emailSettings = await getEmailSettings();

    // Get PDF attachment once if enabled (shared across all emails)
    let pdfAttachment: { filename: string; content: Buffer } | null = null;
    if (emailSettings.include_pdf_attachment && bill.pdf_url) {
      pdfAttachment = await getPdfAttachment(bill.pdf_url);
    }

    const results = [];
    for (const invoiceDoc of invoicesSnapshot.docs) {
      const invoice = invoiceDoc.data() as Invoice;
      try {
        const html = generateInvoiceHtml(
          invoice,
          bill.bill_date,
          billId,
          emailSettings.payment_instructions || undefined
        );
        
        const mailOptions: nodemailer.SendMailOptions = {
          to: invoice.tenant_email,
          subject: `Utility Invoice - ${bill.bill_date}`,
          html,
        };

        if (pdfAttachment) {
          mailOptions.attachments = [{
            filename: pdfAttachment.filename,
            content: pdfAttachment.content,
          }];
        }

        const result = await transporter.sendMail(mailOptions);
        const now = admin.firestore.Timestamp.now();

        // Create email log entry
        const emailLogEntry: EmailLogEntry = {
          type: "invoice",
          sent_at: now,
          message_id: result.messageId,
          recipient: invoice.tenant_email,
          success: true,
        };

        // Update invoice with email log and status
        await invoiceDoc.ref.update({
          status: "INVOICED",
          email_log: admin.firestore.FieldValue.arrayUnion(emailLogEntry),
          first_sent_at: invoice.first_sent_at || now,
        });

        results.push({ id: invoiceDoc.id, success: true, messageId: result.messageId });
      } catch (error) {
        console.error(`Failed to send to ${invoice.tenant_email}:`, error);
        
        const now = admin.firestore.Timestamp.now();
        // Log failed email attempt
        const failedEmailLogEntry: EmailLogEntry = {
          type: "invoice",
          sent_at: now,
          message_id: null,
          recipient: invoice.tenant_email,
          success: false,
          error: String(error),
        };

        // Still update invoice to INVOICED status but with failed email log
        await invoiceDoc.ref.update({
          status: "INVOICED",
          email_log: admin.firestore.FieldValue.arrayUnion(failedEmailLogEntry),
        });

        results.push({
          id: invoiceDoc.id,
          success: false,
          error: String(error),
        });
      }
    }

    // Get total invoice count (including any that weren't sent because they weren't DRAFT)
    const allInvoicesSnapshot = await db
      .collection("bills")
      .doc(billId)
      .collection("invoices")
      .get();
    const totalInvoices = allInvoicesSnapshot.size;

    // Update bill status with invoice counts
    await billDoc.ref.update({
      status: "INVOICED",
      approved_at: admin.firestore.Timestamp.now(),
      approved_by: context.auth.uid,
      invoices_total: totalInvoices,
      invoices_paid: 0,
    });

    return { success: true, results };
  } catch (error) {
    console.error("Error sending invoices:", error);
    throw new functions.https.HttpsError("internal", "Failed to send invoices");
  }
});

// Helper function to download PDF from URL (for test emails)
async function downloadPdfFromUrl(url: string): Promise<{ filename: string; content: Buffer } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`Failed to download PDF: ${response.status}`);
      return null;
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const content = Buffer.from(arrayBuffer);
    
    // Extract filename from URL or use default
    let filename = "utility-bill.pdf";
    try {
      const urlPath = new URL(url).pathname;
      const decoded = decodeURIComponent(urlPath);
      const pathParts = decoded.split("/");
      const lastPart = pathParts[pathParts.length - 1];
      if (lastPart && lastPart.endsWith(".pdf")) {
        filename = lastPart;
      }
    } catch {
      // Use default filename
    }
    
    return { filename, content };
  } catch (error) {
    console.error("Error downloading PDF from URL:", error);
    return null;
  }
}

// Cloud Function: Send test email
export const sendTestEmail = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be authenticated"
    );
  }

  const { email, billId, pdfUrl } = data;
  if (!email) {
    throw new functions.https.HttpsError("invalid-argument", "email required");
  }

  try {
    // Get transporter
    const transporter = await getGmailTransporter();
    if (!transporter) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Email not configured"
      );
    }

    // Get email settings
    const emailSettings = await getEmailSettings();

    // Create a sample invoice for testing
    const sampleInvoice: Invoice = {
      unit_id: "test",
      unit_name: "Test Unit 101",
      tenant_email: email,
      amount: 125.67,
      line_items: [
        { description: "Water: Base charge", amount: 15.50, category: "water_usage" },
        { description: "Water: Usage (1,500 gal)", amount: 28.35, category: "water_usage" },
        { description: "Water: Common area", amount: 4.25, category: "water_sqft" },
        { description: "Sewer: Volume charge", amount: 32.50, category: "sewer" },
        { description: "Sewer: Common area", amount: 3.75, category: "sewer" },
        { description: "Drainage", amount: 18.00, category: "drainage" },
        { description: "Garbage (32 gal)", amount: 15.82, category: "solid_waste" },
        { description: "Recycling (90 gal)", amount: 5.50, category: "solid_waste" },
        { description: "Credit: Rate adjustment", amount: -2.00, category: "adjustment" },
      ],
      status: "DRAFT",
      paid_at: null,
      email_log: [],
      first_sent_at: null,
      reminders_sent: 0,
    };

    const testBillId = billId || "test-bill-id";
    const testBillDate = new Date().toLocaleDateString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
    });

    // Generate email HTML
    const html = generateInvoiceHtml(
      sampleInvoice,
      testBillDate,
      testBillId,
      emailSettings.payment_instructions || undefined
    );

    // Prepare email options
    const mailOptions: nodemailer.SendMailOptions = {
      to: email,
      subject: `[TEST] Utility Invoice - ${testBillDate}`,
      html,
    };

    // Add PDF attachment - try pdfUrl first, then billId
    let attachment: { filename: string; content: Buffer } | null = null;
    
    if (pdfUrl) {
      // Direct PDF URL provided (for testing)
      console.log(`Downloading PDF from URL: ${pdfUrl}`);
      if (pdfUrl.startsWith("gs://") || pdfUrl.includes("storage.googleapis.com")) {
        // Use Firebase Storage API for gs:// or storage.googleapis.com URLs
        attachment = await getPdfAttachment(pdfUrl);
      } else {
        // Use HTTP fetch for other URLs (e.g., firebasestorage.googleapis.com with token)
        attachment = await downloadPdfFromUrl(pdfUrl);
      }
    } else if (emailSettings.include_pdf_attachment && billId) {
      // Try to get PDF from bill document
      const billDoc = await db.collection("bills").doc(billId).get();
      if (billDoc.exists) {
        const bill = billDoc.data()!;
        if (bill.pdf_url) {
          attachment = await getPdfAttachment(bill.pdf_url);
        }
      }
    }
    
    if (attachment) {
      mailOptions.attachments = [{
        filename: attachment.filename,
        content: attachment.content,
      }];
      console.log(`Attaching PDF: ${attachment.filename}`);
    }

    await transporter.sendMail(mailOptions);

    console.log(`Test email sent to ${email}`);
    return { success: true, hasAttachment: !!attachment };
  } catch (error) {
    console.error("Error sending test email:", error);
    throw new functions.https.HttpsError(
      "internal",
      error instanceof Error ? error.message : "Failed to send test email"
    );
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

        // Get unpaid invoices (INVOICED status, not yet PAID)
        const invoicesSnapshot = await billDoc.ref
          .collection("invoices")
          .where("status", "==", "INVOICED")
          .get();

        for (const invoiceDoc of invoicesSnapshot.docs) {
          const invoice = invoiceDoc.data() as Invoice;

          // Use first_sent_at for calculating reminder timing
          const firstSentAt = invoice.first_sent_at;
          if (!firstSentAt) continue;

          // Calculate days since first sent
          const sentDate = firstSentAt.toDate();
          const daysSinceSent = Math.floor(
            (Date.now() - sentDate.getTime()) / (1000 * 60 * 60 * 24)
          );

          const remindersSentCount = invoice.reminders_sent || 0;

          // Check if we should send a reminder
          for (let i = 0; i < reminderDays.length; i++) {
            const reminderDay = reminderDays[i];
            if (daysSinceSent === reminderDay && remindersSentCount <= i) {
              // Send reminder
              const html = generateReminderHtml(
                invoice,
                bill.bill_date,
                daysSinceSent
              );
              
              try {
                const result = await transporter.sendMail({
                  to: invoice.tenant_email,
                  subject: `Payment Reminder - Utility Invoice ${bill.bill_date}`,
                  html,
                });

                const now = admin.firestore.Timestamp.now();
                
                // Create reminder email log entry
                const reminderLogEntry: EmailLogEntry = {
                  type: "reminder",
                  sent_at: now,
                  message_id: result.messageId,
                  recipient: invoice.tenant_email,
                  success: true,
                };

                await invoiceDoc.ref.update({
                  reminders_sent: remindersSentCount + 1,
                  email_log: admin.firestore.FieldValue.arrayUnion(reminderLogEntry),
                });

                remindersSent++;
                console.log(
                  `Reminder sent to ${invoice.tenant_email} (${daysSinceSent} days), message ID: ${result.messageId}`
                );
              } catch (reminderError) {
                console.error(`Failed to send reminder to ${invoice.tenant_email}:`, reminderError);
                
                // Log failed reminder attempt
                const failedReminderLogEntry: EmailLogEntry = {
                  type: "reminder",
                  sent_at: admin.firestore.Timestamp.now(),
                  message_id: null,
                  recipient: invoice.tenant_email,
                  success: false,
                  error: String(reminderError),
                };

                await invoiceDoc.ref.update({
                  email_log: admin.firestore.FieldValue.arrayUnion(failedReminderLogEntry),
                });
              }
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
