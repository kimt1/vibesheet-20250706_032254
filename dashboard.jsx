import React, { useState, useEffect } from 'react';
import { notification } from 'antd'; // Added Ant Design notification import

// Placeholder API function implementations:
// Remove and replace with real functions as appropriate for integration.
const oauthLogin = async (oauthData) => {
  return {
    id: 'user123',
    name: 'Jane',
    email: 'jane@example.com'
  };
};
const connectGoogleSheetsAPI = async (accountInfo) => true;
const getAutomationProfiles = async () => [
  { id: 'p1', name: 'Sample Profile', formUrl: 'https://example.com/form1', status: 'Active' }
];
const saveAutomationProfile = async (profileData) => true;
const getSubmissionStats = async () => ({
  totalSubmissions: 120,
  successRate: 92,
  errorCount: 7
});
const exportAnalytics = async (format) => true;
const scheduleBatch = async (batchSettings) => true;

const Dashboard = (props) => { // Changed to accept props directly
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [googleSheetsConnected, setGoogleSheetsConnected] = useState(false);
  const [accountInfo, setAccountInfo] = useState(null);
  const [automationProfiles, setAutomationProfiles] = useState([]);
  const [activeProfile, setActiveProfile] = useState(null);
  const [profileModalVisible, setProfileModalVisible] = useState(false);
  const [newProfileData, setNewProfileData] = useState({ name: '', formUrl: '' });
  const [batchModalVisible, setBatchModalVisible] = useState(false);
  const [batchSettings, setBatchSettings] = useState({ name: '', startTime: '', runs: '' });
  const [stats, setStats] = useState(null);
  const [exporting, setExporting] = useState(false);

  // --- Authentication Handler ---
  const handleLogin = async (oauthData) => {
    setIsLoading(true);
    try {
      const userData = await oauthLogin(oauthData);
      setUser(userData);
      notification.success({ message: 'Logged in successfully' });
      await loadAutomationProfiles();
      await displaySubmissionStats();
    } catch (error) {
      notification.error({ message: 'Login failed', description: error.message || String(error) });
    } finally {
      setIsLoading(false);
    }
  };

  // --- Google Sheets Connection ---
  const handleConnectGoogleSheets = async (accountInfoParam) => {
    setIsLoading(true);
    try {
      await connectGoogleSheetsAPI(accountInfoParam || accountInfo);
      setGoogleSheetsConnected(true);
      notification.success({ message: 'Google Sheets connected' });
    } catch (err) {
      notification.error({ message: 'Google Sheets connection failed', description: err.message || String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  // --- Automation Profile Load ---
  const loadAutomationProfiles = async () => {
    setIsLoading(true);
    try {
      const profiles = await getAutomationProfiles();
      setAutomationProfiles(profiles);
    } catch (err) {
      notification.error({ message: 'Could not load profiles', description: err.message || String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  // --- Profile Save Handler ---
  const saveProfile = async () => {
    setIsLoading(true);
    try {
      const profileToSave = activeProfile
        ? { ...activeProfile }
        : { ...newProfileData };
      // Ensure minimum fields provided before saving (add more validations as needed)
      if (!profileToSave.name || !profileToSave.formUrl) {
        notification.error({
          message: 'Missing Fields',
          description: 'Profile Name and Target Form URL are required.'
        });
        setIsLoading(false);
        return;
      }
      await saveAutomationProfile(profileToSave);
      notification.success({ message: 'Profile saved' });
      setProfileModalVisible(false);
      setActiveProfile(null);
      setNewProfileData({ name: '', formUrl: '' });
      await loadAutomationProfiles();
    } catch (err) {
      notification.error({ message: 'Profile save failed', description: err.message || String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  // --- Batch Automation Scheduler ---
  const scheduleBatchAutomation = async () => {
    setIsLoading(true);
    try {
      // Validate batchSettings
      if (!batchSettings.name || !batchSettings.startTime || !batchSettings.runs || Number.isNaN(batchSettings.runs)) {
        notification.error({
          message: 'Missing Fields',
          description: 'Please provide all batch settings fields.'
        });
        setIsLoading(false);
        return;
      }
      await scheduleBatch(batchSettings);
      notification.success({ message: 'Batch scheduled' });
      setBatchModalVisible(false);
      setBatchSettings({ name: '', startTime: '', runs: '' });
    } catch (err) {
      notification.error({ message: 'Batch scheduling failed', description: err.message || String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  // --- Submission Stats Handler ---
  const displaySubmissionStats = async () => {
    setIsLoading(true);
    try {
      const fetchedStats = await getSubmissionStats();
      setStats(fetchedStats);
    } catch (err) {
      notification.error({ message: 'Failed to load stats', description: err.message || String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  // --- Analytics Export Handler ---
  const exportAnalyticsData = async (format) => {
    if (!format) return; // Don't export on clear/undefined
    setExporting(true);
    try {
      await exportAnalytics(format);
      // In real implementation, trigger file download
      notification.success({ message: `Analytics exported as ${format}` });
    } catch (err) {
      notification.error({ message: 'Analytics export failed', description: err.message || String(err) });
    } finally {
      setExporting(false);
    }
  };

  // --- Initial Load ---
  useEffect(() => {
    if (user) {
      loadAutomationProfiles();
      displaySubmissionStats();
    }
    // eslint-disable-next-line
  }, [user]);

  // --- Modal Open/Close Handlers (for clean state) ---
  const handleOpenNewProfileModal = () => {
    setActiveProfile(null);
    setNewProfileData({ name: '', formUrl: '' });
    setProfileModalVisible(true);
  };

  const handleOpenEditProfileModal = (profile) => {
    setActiveProfile({ ...profile });
    setNewProfileData({ name: '', formUrl: '' });
    setProfileModalVisible(true);
  };

  const handleCloseProfileModal = () => {
    setProfileModalVisible(false);
    setActiveProfile(null);
    setNewProfileData({ name: '', formUrl: '' });
  };

  const handleOpenBatchModal = () => {
    setBatchSettings({ name: '', startTime: '', runs: '' });
    setBatchModalVisible(true);
  };

  const handleCloseBatchModal = () => {
    setBatchModalVisible(false);
    setBatchSettings({ name: '', startTime: '', runs: '' });
  };

  // Profile Table Columns
  const profileColumns = [
    { title: 'Profile Name', dataIndex: 'name', key: 'name' },
    { title: 'Target Form', dataIndex: 'formUrl', key: 'formUrl' },
    { title: 'Status', dataIndex: 'status', key: 'status' },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, rec) => (
        <Button
          onClick={() => handleOpenEditProfileModal(rec)}
        >
          Edit
        </Button>
      ),
    }
  ];

  // Unified profile form state binding (either new or edit)
  const profileFormData = activeProfile ? activeProfile : newProfileData;
  const setProfileFormData = activeProfile
    ? (upd) => setActiveProfile({ ...activeProfile, ...upd })
    : (upd) => setNewProfileData({ ...newProfileData, ...upd });

  return (
    <Spin spinning={isLoading}>
      <Card
        title="Form Master Dashboard"
        extra={
          !user ? (
            <Button
              icon={<GoogleOutlined />}
              onClick={() => handleLogin({ provider: 'google-oauth' })}
              type="primary"
            >
              Login with Google
            </Button>
          ) : (
            <Button icon={<ReloadOutlined />} onClick={() => setUser(null)}>
              Logout
            </Button>
          )
        }
      >
        {user && (
          <>
            <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16 }}>
              <Button
                icon={<GoogleOutlined />}
                onClick={() => handleConnectGoogleSheets(accountInfo)}
                disabled={googleSheetsConnected}
              >
                {googleSheetsConnected ? 'Google Sheets Connected' : 'Connect Google Sheets'}
              </Button>
              <Button
                type="primary"
                onClick={handleOpenNewProfileModal}
              >
                New Automation Profile
              </Button>
              <Button
                icon={<BarChartOutlined />}
                onClick={() => displaySubmissionStats()}
              >
                Refresh Stats
              </Button>
              <Select
                placeholder="Export Analytics"
                style={{ width: 180 }}
                value={undefined}
                onChange={(value) => exportAnalyticsData(value)}
                disabled={exporting}
                allowClear
                options={[
                  { value: 'csv', label: 'Export as CSV' },
                  { value: 'xml', label: 'Export as XML' },
                  { value: 'json', label: 'Export as JSON' }
                ]}
                suffixIcon={<ExportOutlined />}
              />
              <Button
                onClick={handleOpenBatchModal}
                type="dashed"
              >
                Schedule Batch Automation
              </Button>
            </div>
            <Card
              title="Submission Stats"
              style={{ marginBottom: 24 }}
              extra={
                <ReloadOutlined
                  onClick={displaySubmissionStats}
                  style={{ cursor: 'pointer' }}
                />
              }
            >
              {stats ? (
                <div style={{ display: 'flex', gap: 42 }}>
                  <Statistic title="Total Submissions" value={stats.totalSubmissions} />
                  <Statistic title="Success Rate" value={`${stats.successRate || 0}%`} />
                  <Statistic title="Errors" value={stats.errorCount} />
                </div>
              ) : (
                <div>No stats available.</div>
              )}
            </Card>
            <Table
              dataSource={automationProfiles}
              columns={profileColumns}
              rowKey="id"
              pagination={{ pageSize: 6 }}
              title={() => 'Automation Profiles'}
            />
          </>
        )}

        {/* Automation Profile Modal */}
        <Modal
          open={profileModalVisible}
          title={activeProfile ? 'Edit Profile' : 'New Automation Profile'}
          onCancel={handleCloseProfileModal}
          onOk={saveProfile}
          okText="Save"
          destroyOnClose
        >
          <Input
            placeholder="Profile Name"
            value={profileFormData.name}
            onChange={e => setProfileFormData({ name: e.target.value })}
            style={{ marginBottom: 16 }}
          />
          <Input
            placeholder="Target Form URL"
            value={profileFormData.formUrl}
            onChange={e => setProfileFormData({ formUrl: e.target.value })}
            style={{ marginBottom: 16 }}
          />
          {/* Add more profile fields as needed */}
        </Modal>

        {/* Batch Scheduling Modal */}
        <Modal
          open={batchModalVisible}
          title="Schedule Batch Automation"
          onCancel={handleCloseBatchModal}
          onOk={scheduleBatchAutomation}
          okText="Schedule"
          destroyOnClose
        >
          <Input
            placeholder="Batch Name"
            value={batchSettings.name}
            onChange={e => setBatchSettings({ ...batchSettings, name: e.target.value })}
            style={{ marginBottom: 16 }}
          />
          <Input
            placeholder="Start Time (ISO)"
            value={batchSettings.startTime}
            onChange={e => setBatchSettings({ ...batchSettings, startTime: e.target.value })}
            style={{ marginBottom: 16 }}
          />
          <Input
            placeholder="Number of Runs"
            type="number"
            value={batchSettings.runs}
            onChange={e => {
              const val = e.target.value;
              // Accept empty or valid number only
              setBatchSettings({ ...batchSettings, runs: val === '' ? '' : Number(val) });
            }}
            style={{ marginBottom: 16 }}
            min={1}
          />
          {/* More batch settings as needed */}
        </Modal>
      </Card>
    </Spin>
  );
};

// Define PropTypes for any used props or remove if unused
Dashboard.propTypes = {
  // No props in use, but structure in place for extension
};

export default Dashboard;