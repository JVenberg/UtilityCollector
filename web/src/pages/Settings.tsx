import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { doc, getDoc, setDoc, onSnapshot, Timestamp } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../firebase';
import { useAuth } from '../hooks/useAuth';
import { useUsers, useCurrentUserRole } from '../hooks/useUsers';
import type { UserRole } from '../types';

// Bootstrap admin email from environment variable
const BOOTSTRAP_ADMIN_EMAIL = import.meta.env.VITE_BOOTSTRAP_ADMIN_EMAIL?.toLowerCase() || '';

interface UtilityCredentials {
  seattle_utilities_username: string;
  seattle_utilities_password: string;
  seattle_utilities_account: string;
  nextcentury_username: string;
  nextcentury_password: string;
  nextcentury_property_id: string;
}

interface CommunitySettings {
  require_approval: boolean;
  reminder_days: number[];
}

interface EmailSettings {
  payment_instructions: string; // HTML-enabled instructions for payment
  include_pdf_attachment: boolean; // Whether to attach bill PDF to email
  hoa_name: string; // Optional HOA/property name for branding
  test_email: string; // Email address for test emails
  test_pdf_url: string; // Optional PDF URL for test emails
}

interface GmailToken {
  access_token: string;
  refresh_token: string;
  email: string;
  scope: string;
  expiry?: { toDate: () => Date };
  updated_at?: { toDate: () => Date };
}

interface ScraperStatus {
  status: 'idle' | 'running' | 'completed' | 'error';
  started_at?: Timestamp;
  completed_at?: Timestamp;
  error?: string;
  result?: {
    new_bills?: number;
    total_checked?: number;
  };
}

export function Settings() {
  const { user } = useAuth();
  const { role, isAdmin, loading: roleLoading } = useCurrentUserRole(user?.email);
  const { users, addUser, updateUserRole, removeUser, bootstrapAdmin, loading: usersLoading } = useUsers();

  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserRole, setNewUserRole] = useState<UserRole>('member');
  const [addingUser, setAddingUser] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);

  const [credentials, setCredentials] = useState<UtilityCredentials>({
    seattle_utilities_username: '',
    seattle_utilities_password: '',
    seattle_utilities_account: '',
    nextcentury_username: '',
    nextcentury_password: '',
    nextcentury_property_id: '',
  });
  const [settings, setSettings] = useState<CommunitySettings>({
    require_approval: true,
    reminder_days: [7, 14],
  });
  const [emailSettings, setEmailSettings] = useState<EmailSettings>({
    payment_instructions: '',
    include_pdf_attachment: true,
    hoa_name: '',
    test_email: '',
    test_pdf_url: '',
  });
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showPasswords, setShowPasswords] = useState(false);
  const [scraperStatus, setScraperStatus] = useState<ScraperStatus>({ status: 'idle' });
  const [triggeringScraper, setTriggeringScraper] = useState(false);

  // Gmail OAuth token state
  const [gmailToken, setGmailToken] = useState<GmailToken | null>(null);
  const [connectingGmail, setConnectingGmail] = useState(false);
  const [disconnectingGmail, setDisconnectingGmail] = useState(false);

  // Handle OAuth callback URL params
  const [searchParams, setSearchParams] = useSearchParams();

  // Check if current user can bootstrap (is the designated bootstrap admin and no admin exists)
  const isBootstrapEmail = BOOTSTRAP_ADMIN_EMAIL && user?.email?.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
  const noAdminsExist = !usersLoading && users.filter(u => u.role === 'admin').length === 0;
  const canBootstrap = isBootstrapEmail && noAdminsExist;
  const showAdminSection = isAdmin || canBootstrap;

  // Handle OAuth callback result from URL params
  useEffect(() => {
    const gmailSuccess = searchParams.get('gmail_success');
    const gmailError = searchParams.get('gmail_error');

    if (gmailSuccess === 'true') {
      setMessage({ type: 'success', text: 'Gmail connected successfully!' });
      // Reload Gmail token status
      loadGmailToken();
      // Clear URL params
      setSearchParams({});
    } else if (gmailError) {
      setMessage({ type: 'error', text: `Failed to connect Gmail: ${gmailError}` });
      setSearchParams({});
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    loadSettings();
    loadGmailToken();

    // Subscribe to scraper status updates
    const unsubscribe = onSnapshot(
      doc(db, 'settings', 'scraper_status'),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data() as ScraperStatus;

          // Auto-reset if stuck in running state for more than 9 minutes
          // (Cloud Function timeout is 540 seconds = 9 minutes)
          if (data.status === 'running' && data.started_at) {
            const startedAt = data.started_at.toDate();
            const functionTimeout = new Date(Date.now() - 9 * 60 * 1000);
            if (startedAt < functionTimeout) {
              // Status is stale - the Cloud Function likely timed out
              setScraperStatus({
                status: 'error',
                started_at: data.started_at,
                completed_at: Timestamp.now(),
                error: 'Cloud Function timed out after 9 minutes. The scraper may still be processing - check the Bills page.',
              });
              return;
            }
          }

          setScraperStatus(data);
        }
      },
      (error) => {
        console.error('Error listening to scraper status:', error);
      }
    );

    return () => unsubscribe();
  }, []);

  async function loadSettings() {
    try {
      // Load utility credentials
      const credsDoc = await getDoc(doc(db, 'settings', 'utility_credentials'));
      if (credsDoc.exists()) {
        setCredentials(credsDoc.data() as UtilityCredentials);
      }

      // Load community settings
      const settingsDoc = await getDoc(doc(db, 'settings', 'community'));
      if (settingsDoc.exists()) {
        setSettings(settingsDoc.data() as CommunitySettings);
      }

      // Load email settings
      const emailDoc = await getDoc(doc(db, 'settings', 'email'));
      if (emailDoc.exists()) {
        setEmailSettings({
          ...emailSettings,
          ...(emailDoc.data() as EmailSettings),
        });
      }

    } catch (error) {
      console.error('Error loading settings:', error);
      setMessage({ type: 'error', text: 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  }

  async function loadGmailToken() {
    try {
      const gmailDoc = await getDoc(doc(db, 'settings', 'gmail_token'));
      if (gmailDoc.exists()) {
        setGmailToken(gmailDoc.data() as GmailToken);
      } else {
        setGmailToken(null);
      }
    } catch (error) {
      console.error('Error loading Gmail token:', error);
    }
  }

  async function connectGmail() {
    setConnectingGmail(true);
    setMessage(null);
    try {
      const getGmailAuthUrl = httpsCallable<unknown, { authUrl: string }>(functions, 'getGmailAuthUrl');
      const result = await getGmailAuthUrl({});
      // Redirect to Google OAuth
      window.location.href = result.data.authUrl;
    } catch (error) {
      console.error('Error getting Gmail auth URL:', error);
      setMessage({ type: 'error', text: 'Failed to start Gmail authorization' });
      setConnectingGmail(false);
    }
  }

  async function disconnectGmail() {
    if (!confirm('Are you sure you want to disconnect Gmail? Invoice emails will not be sent until reconnected.')) {
      return;
    }
    setDisconnectingGmail(true);
    setMessage(null);
    try {
      const disconnectGmailFn = httpsCallable(functions, 'disconnectGmail');
      await disconnectGmailFn({});
      setGmailToken(null);
      setMessage({ type: 'success', text: 'Gmail disconnected' });
    } catch (error) {
      console.error('Error disconnecting Gmail:', error);
      setMessage({ type: 'error', text: 'Failed to disconnect Gmail' });
    } finally {
      setDisconnectingGmail(false);
    }
  }

  async function saveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      await setDoc(doc(db, 'settings', 'utility_credentials'), {
        ...credentials,
        updated_at: new Date(),
      });
      setMessage({ type: 'success', text: 'Utility credentials saved!' });
    } catch (error) {
      console.error('Error saving credentials:', error);
      setMessage({ type: 'error', text: 'Failed to save credentials' });
    } finally {
      setSaving(false);
    }
  }

  async function saveCommunitySettings(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      await setDoc(doc(db, 'settings', 'community'), {
        ...settings,
        updated_at: new Date(),
      });
      setMessage({ type: 'success', text: 'Community settings saved!' });
    } catch (error) {
      console.error('Error saving settings:', error);
      setMessage({ type: 'error', text: 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  }

  async function saveEmailSettings(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      await setDoc(doc(db, 'settings', 'email'), {
        ...emailSettings,
        updated_at: new Date(),
      });
      setMessage({ type: 'success', text: 'Email settings saved!' });
    } catch (error) {
      console.error('Error saving email settings:', error);
      setMessage({ type: 'error', text: 'Failed to save email settings' });
    } finally {
      setSaving(false);
    }
  }

  async function sendTestEmail() {
    if (!emailSettings.test_email) {
      setMessage({ type: 'error', text: 'Please enter a test email address' });
      return;
    }

    setSendingTestEmail(true);
    setMessage(null);

    try {
      const sendTestFn = httpsCallable<
        { email: string; pdfUrl?: string },
        { success: boolean; hasAttachment?: boolean }
      >(functions, 'sendTestEmail');
      
      const params: { email: string; pdfUrl?: string } = { email: emailSettings.test_email };
      if (emailSettings.test_pdf_url) {
        params.pdfUrl = emailSettings.test_pdf_url;
      }
      
      const result = await sendTestFn(params);
      const attachmentNote = result.data.hasAttachment ? ' (with PDF attachment)' : '';
      setMessage({ type: 'success', text: `Test email sent to ${emailSettings.test_email}${attachmentNote}!` });
    } catch (error) {
      console.error('Error sending test email:', error);
      setMessage({ type: 'error', text: 'Failed to send test email. Check Gmail connection.' });
    } finally {
      setSendingTestEmail(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {message && (
        <div
          className={`p-4 rounded-md ${
            message.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Utility Credentials */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Utility Account Credentials</h2>
        <p className="text-sm text-gray-600 mb-6">
          These credentials are used by the scraper to automatically download bills.
        </p>

        <form onSubmit={saveCredentials} className="space-y-6">
          {/* Seattle Utilities */}
          <div className="border-b pb-6">
            <h3 className="text-md font-medium text-gray-800 mb-4">Seattle Utilities</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Account Number</label>
                <input
                  type="text"
                  value={credentials.seattle_utilities_account}
                  onChange={(e) =>
                    setCredentials({ ...credentials, seattle_utilities_account: e.target.value })
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border"
                  placeholder="e.g., 1234567890"
                />
              </div>
              <div></div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Username</label>
                <input
                  type="text"
                  value={credentials.seattle_utilities_username}
                  onChange={(e) =>
                    setCredentials({ ...credentials, seattle_utilities_username: e.target.value })
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border"
                  placeholder="Username"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Password</label>
                <div className="relative">
                  <input
                    type={showPasswords ? 'text' : 'password'}
                    value={credentials.seattle_utilities_password}
                    onChange={(e) =>
                      setCredentials({ ...credentials, seattle_utilities_password: e.target.value })
                    }
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border pr-10"
                    placeholder="Password"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* NextCentury Meters */}
          <div className="pb-4">
            <h3 className="text-md font-medium text-gray-800 mb-4">NextCentury Meters (Optional)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Property ID</label>
                <input
                  type="text"
                  value={credentials.nextcentury_property_id}
                  onChange={(e) =>
                    setCredentials({ ...credentials, nextcentury_property_id: e.target.value })
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border"
                  placeholder="Property ID"
                />
              </div>
              <div></div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Username</label>
                <input
                  type="text"
                  value={credentials.nextcentury_username}
                  onChange={(e) =>
                    setCredentials({ ...credentials, nextcentury_username: e.target.value })
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border"
                  placeholder="Username"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Password</label>
                <input
                  type={showPasswords ? 'text' : 'password'}
                  value={credentials.nextcentury_password}
                  onChange={(e) =>
                    setCredentials({ ...credentials, nextcentury_password: e.target.value })
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border"
                  placeholder="Password"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={showPasswords}
                onChange={(e) => setShowPasswords(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm text-gray-600">Show passwords</span>
            </label>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Credentials'}
            </button>
          </div>
        </form>
      </div>

      {/* Gmail OAuth Configuration - Admin Only */}
      {isAdmin && (
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Gmail Configuration (for Invoices)</h2>
          <p className="text-sm text-gray-600 mb-4">
            Connect a Gmail account to send invoice emails to tenants.
          </p>

          {/* Current Token Status */}
          <div className="mb-6 p-4 rounded-md bg-gray-50 border">
            <h3 className="text-sm font-medium text-gray-700 mb-2">Current Status</h3>
            {gmailToken ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <svg className="h-5 w-5 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span className="text-sm text-green-700">
                    Gmail connected: <strong>{gmailToken.email}</strong>
                  </span>
                </div>
                {gmailToken.updated_at && (
                  <p className="text-xs text-gray-500">
                    Connected: {gmailToken.updated_at.toDate().toLocaleString()}
                  </p>
                )}
                <button
                  onClick={disconnectGmail}
                  disabled={disconnectingGmail}
                  className="text-sm text-red-600 hover:text-red-800 underline disabled:opacity-50"
                >
                  {disconnectingGmail ? 'Disconnecting...' : 'Disconnect Gmail'}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <svg className="h-5 w-5 text-yellow-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  <span className="text-sm text-yellow-700">
                    Gmail not connected. Invoices cannot be sent until connected.
                  </span>
                </div>
                <button
                  onClick={connectGmail}
                  disabled={connectingGmail}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                >
                  {connectingGmail ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                      Connecting...
                    </>
                  ) : (
                    <>
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
                      </svg>
                      Connect Gmail Account
                    </>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* How it works */}
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-md">
            <h3 className="text-sm font-medium text-blue-800 mb-2">How it works:</h3>
            <ul className="text-sm text-blue-700 list-disc ml-4 space-y-1">
              <li>Click "Connect Gmail Account" to authorize sending emails</li>
              <li>Sign in with the Gmail account you want to send invoices from</li>
              <li>Grant permission to send emails on your behalf</li>
              <li>Invoices will be sent from the connected Gmail address</li>
            </ul>
          </div>
        </div>
      )}

      {/* Email Settings - Admin Only */}
      {isAdmin && (
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Invoice Email Settings</h2>
          <p className="text-sm text-gray-600 mb-6">
            Customize what appears in invoice emails sent to tenants.
          </p>

          <form onSubmit={saveEmailSettings} className="space-y-6">
            {/* HOA Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                HOA / Property Name
              </label>
              <p className="text-xs text-gray-500 mb-2">
                Your HOA or property name. If provided, it will appear in email subjects and headers for branding. Leave blank if not needed.
              </p>
              <input
                type="text"
                value={emailSettings.hoa_name}
                onChange={(e) => setEmailSettings({ ...emailSettings, hoa_name: e.target.value })}
                className="w-full max-w-md rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-sm"
                placeholder="e.g., Capitol Hill HOA"
              />
            </div>

            {/* Payment Instructions */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Payment Instructions (Optional)
              </label>
              <p className="text-xs text-gray-500 mb-2">
                If provided, this text appears in a highlighted box in invoice emails.
                You can include payment links (Venmo, PayPal, etc.).
                Leave blank to not show any payment instructions section.
                HTML links are supported: &lt;a href="..."&gt;text&lt;/a&gt;
              </p>
              <textarea
                value={emailSettings.payment_instructions}
                onChange={(e) => setEmailSettings({ ...emailSettings, payment_instructions: e.target.value })}
                rows={6}
                className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-3 border font-mono text-sm"
                placeholder="Example:&#10;Please submit payment by the 15th of the month.&#10;&#10;Venmo: @YourHandle&#10;Or mail a check to: 123 Main St, Seattle, WA 98101"
              />
            </div>

            {/* PDF Attachment Toggle */}
            <div>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={emailSettings.include_pdf_attachment}
                  onChange={(e) => setEmailSettings({ ...emailSettings, include_pdf_attachment: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700">
                  Attach bill PDF to invoice emails
                </span>
              </label>
              <p className="mt-1 text-xs text-gray-500 ml-6">
                When enabled, the original utility bill PDF will be attached to each invoice email.
              </p>
            </div>

            {/* Test Email */}
            <div className="border-t pt-6">
              <h3 className="text-sm font-medium text-gray-700 mb-3">Send Test Email</h3>
              <p className="text-xs text-gray-500 mb-3">
                Send a sample invoice email to test how it looks. Uses dummy data.
              </p>
              <div className="space-y-3">
                <div className="flex gap-3 items-end">
                  <div className="flex-1">
                    <label className="block text-xs text-gray-500 mb-1">Test Email Address</label>
                    <input
                      type="email"
                      value={emailSettings.test_email}
                      onChange={(e) => setEmailSettings({ ...emailSettings, test_email: e.target.value })}
                      placeholder="your@email.com"
                      className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={sendTestEmail}
                    disabled={sendingTestEmail || !gmailToken}
                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 text-sm whitespace-nowrap"
                  >
                    {sendingTestEmail ? 'Sending...' : 'Send Test Email'}
                  </button>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Test PDF URL (Optional)</label>
                  <input
                    type="url"
                    value={emailSettings.test_pdf_url}
                    onChange={(e) => setEmailSettings({ ...emailSettings, test_pdf_url: e.target.value })}
                    placeholder="https://firebasestorage.googleapis.com/..."
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-sm"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Paste a Firebase Storage PDF URL to test with a real bill attachment.
                  </p>
                </div>
              </div>
              {!gmailToken && (
                <p className="text-xs text-yellow-600 mt-2">
                  ⚠️ Connect Gmail above before sending test emails.
                </p>
              )}
            </div>

            <div className="flex justify-end border-t pt-4">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Email Settings'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Community Settings */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Bill Processing Settings</h2>

        <form onSubmit={saveCommunitySettings} className="space-y-6">
          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={settings.require_approval}
                onChange={(e) => setSettings({ ...settings, require_approval: e.target.checked })}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm text-gray-700">
                Require manual approval before sending invoices
              </span>
            </label>
            <p className="mt-1 text-xs text-gray-500 ml-6">
              When enabled, you'll need to review and approve each bill before invoices are emailed to tenants.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Payment Reminder Days
            </label>
            <input
              type="text"
              value={settings.reminder_days.join(', ')}
              onChange={(e) => {
                const days = e.target.value
                  .split(',')
                  .map((d) => parseInt(d.trim()))
                  .filter((d) => !isNaN(d));
                setSettings({ ...settings, reminder_days: days });
              }}
              className="mt-1 block w-full max-w-xs rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border"
              placeholder="7, 14"
            />
            <p className="mt-1 text-xs text-gray-500">
              Comma-separated days after invoice to send reminders (e.g., "7, 14" for 1 and 2 weeks)
            </p>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      </div>

      {/* Scraper Status */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Manual Scraper Trigger</h2>
        <p className="text-sm text-gray-600 mb-4">
          The scraper automatically runs every 3 days. You can also trigger it manually:
        </p>

        {/* Status Display */}
        <div className="mb-4 p-4 rounded-md bg-gray-50 border">
          <div className="flex items-center gap-3">
            {scraperStatus.status === 'running' && (
              <>
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                <span className="text-blue-700 font-medium">Scraper is running...</span>
              </>
            )}
            {scraperStatus.status === 'completed' && (
              <>
                <svg className="h-5 w-5 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span className="text-green-700 font-medium">
                  Completed! Found {scraperStatus.result?.new_bills || 0} new bills
                  (checked {scraperStatus.result?.total_checked || 0} total)
                </span>
              </>
            )}
            {scraperStatus.status === 'error' && (
              <>
                <svg className="h-5 w-5 text-red-600" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <span className="text-red-700 font-medium">Error: {scraperStatus.error}</span>
              </>
            )}
            {scraperStatus.status === 'idle' && (
              <span className="text-gray-600">Ready to run</span>
            )}
          </div>
          {scraperStatus.started_at && (
            <p className="text-xs text-gray-500 mt-2">
              Started: {scraperStatus.started_at.toDate().toLocaleString()}
            </p>
          )}
          {scraperStatus.completed_at && scraperStatus.status !== 'running' && (
            <p className="text-xs text-gray-500">
              Completed: {scraperStatus.completed_at.toDate().toLocaleString()}
            </p>
          )}
        </div>

        <button
          onClick={async () => {
            setTriggeringScraper(true);
            setMessage(null);
            try {
              const triggerScraper = httpsCallable(functions, 'triggerScraperManual');
              await triggerScraper({});
              // Status will update via onSnapshot
            } catch (error) {
              console.error('Error triggering scraper:', error);
              setMessage({ type: 'error', text: 'Failed to trigger scraper' });
            } finally {
              setTriggeringScraper(false);
            }
          }}
          disabled={triggeringScraper || scraperStatus.status === 'running'}
          className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {triggeringScraper ? 'Triggering...' : scraperStatus.status === 'running' ? 'Running...' : 'Run Scraper Now'}
        </button>
      </div>

      {/* User Management - Admin Only (or Bootstrap) */}
      {showAdminSection && (
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">User Management</h2>
          <p className="text-sm text-gray-600 mb-4">
            Manage who can access this application. Admins can manage all settings, members can only view and approve bills.
          </p>

          {/* Bootstrap Admin Button - only shows if no admins exist and user is bootstrap email */}
          {canBootstrap && !isAdmin && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
              <h3 className="text-sm font-medium text-yellow-800 mb-2">🚀 Initial Setup Required</h3>
              <p className="text-sm text-yellow-700 mb-3">
                No admin users exist yet. As the designated bootstrap admin ({BOOTSTRAP_ADMIN_EMAIL}), you can initialize yourself as the first admin.
              </p>
              <button
                onClick={async () => {
                  setBootstrapping(true);
                  try {
                    await bootstrapAdmin(user?.email || BOOTSTRAP_ADMIN_EMAIL);
                    setMessage({ type: 'success', text: 'You are now an admin! You can add other users below.' });
                  } catch (error) {
                    console.error('Error bootstrapping admin:', error);
                    setMessage({ type: 'error', text: 'Failed to bootstrap admin. Check Firestore rules.' });
                  } finally {
                    setBootstrapping(false);
                  }
                }}
                disabled={bootstrapping}
                className="px-4 py-2 bg-yellow-600 text-white rounded-md hover:bg-yellow-700 disabled:opacity-50"
              >
                {bootstrapping ? 'Setting up...' : 'Initialize as Admin'}
              </button>
            </div>
          )}

          {/* Add User Form - only show if user is already admin */}
          {isAdmin && (
            <div className="mb-6 p-4 bg-gray-50 rounded-md">
              <h3 className="text-sm font-medium text-gray-700 mb-3">Add New User</h3>
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">Email</label>
                  <input
                    type="email"
                    value={newUserEmail}
                    onChange={(e) => setNewUserEmail(e.target.value)}
                    placeholder="user@example.com"
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-sm"
                  />
                </div>
                <div className="w-32">
                  <label className="block text-xs text-gray-500 mb-1">Role</label>
                  <select
                    value={newUserRole}
                    onChange={(e) => setNewUserRole(e.target.value as UserRole)}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-sm"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <button
                  onClick={async () => {
                    if (!newUserEmail.trim()) return;
                    setAddingUser(true);
                    try {
                      await addUser(newUserEmail.trim(), newUserRole, user?.email || '');
                      setNewUserEmail('');
                      setNewUserRole('member');
                      setMessage({ type: 'success', text: 'User added successfully!' });
                    } catch (error) {
                      console.error('Error adding user:', error);
                      setMessage({ type: 'error', text: 'Failed to add user' });
                    } finally {
                      setAddingUser(false);
                    }
                  }}
                  disabled={addingUser || !newUserEmail.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 text-sm"
                >
                  {addingUser ? 'Adding...' : 'Add User'}
                </button>
              </div>
            </div>
          )}

          {/* User List */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-gray-700 mb-2">Current Users</h3>
            {users.length === 0 ? (
              <p className="text-sm text-gray-500 italic">No users added yet. {canBootstrap ? 'Click "Initialize as Admin" above to get started.' : 'An admin needs to add you.'}</p>
            ) : (
              users.map((appUser) => (
                <div
                  key={appUser.id}
                  className="flex items-center justify-between p-3 border rounded-md bg-white"
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium ${
                      appUser.role === 'admin' ? 'bg-purple-500' : 'bg-gray-400'
                    }`}>
                      {appUser.email.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{appUser.email}</p>
                      <p className="text-xs text-gray-500">
                        {appUser.role === 'admin' ? '👑 Admin' : '👤 Member'}
                        {appUser.email === user?.email?.toLowerCase() && ' (you)'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isAdmin && (
                      <>
                        <select
                          value={appUser.role}
                          onChange={(e) => updateUserRole(appUser.email, e.target.value as UserRole)}
                          disabled={appUser.email === user?.email?.toLowerCase()}
                          className="text-sm rounded border-gray-300 py-1 px-2 disabled:opacity-50"
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button
                          onClick={() => {
                            if (confirm(`Remove ${appUser.email}?`)) {
                              removeUser(appUser.email);
                            }
                          }}
                          disabled={appUser.email === user?.email?.toLowerCase()}
                          className="text-red-600 hover:text-red-800 disabled:opacity-50 disabled:cursor-not-allowed p-1"
                          title="Remove user"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Current User Info */}
          <div className="mt-4 p-3 bg-blue-50 rounded-md">
            <p className="text-sm text-blue-800">
              <strong>Your account:</strong> {user?.email} ({role || 'not in users list'})
            </p>
            {!role && canBootstrap && (
              <p className="text-xs text-blue-600 mt-1">
                Tip: Click "Initialize as Admin" above to set yourself as admin.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Non-admin notice */}
      {role === 'member' && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-sm text-yellow-800">
            <strong>Member access:</strong> You can view and approve bills. Contact an admin for additional permissions.
          </p>
        </div>
      )}

      {/* Not registered notice */}
      {!roleLoading && !role && !canBootstrap && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm text-red-800">
            <strong>Access restricted:</strong> Your account ({user?.email}) is not in the users list. Contact an admin to be added.
          </p>
        </div>
      )}
    </div>
  );
}
