/**
 * VENTEDA CHAT — Client API Service
 * Handles authentication, REST calls, and local storage state.
 */

const API_BASE = '/api';
const TOKEN_KEY = 'venteda_token';

export const api = {
  getToken() {
    return localStorage.getItem(TOKEN_KEY);
  },
  setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('venteda_user');
  },
  getStoredUser() {
    try {
      const u = localStorage.getItem('venteda_user');
      return u ? JSON.parse(u) : null;
    } catch {
      return null;
    }
  },
  setStoredUser(user) {
    localStorage.setItem('venteda_user', JSON.stringify(user));
  },

  async request(endpoint, options = {}) {
    const headers = options.headers || {};
    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (!(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers
    });

    if (res.status === 401) {
      this.clearToken();
      window.dispatchEvent(new CustomEvent('venteda:unauthorized'));
      throw new Error('Session expired. Please log in again.');
    }

    if (!res.ok) {
      let errorMsg = 'An error occurred';
      try {
        const errJson = await res.json();
        const d = errJson.detail;
        errorMsg = Array.isArray(d)
          ? d.map(x => (x.loc ? x.loc[x.loc.length - 1] + ': ' : '') + x.msg).join(' | ')
          : (d || errJson.message || JSON.stringify(errJson));
      } catch {
        errorMsg = res.statusText;
      }
      throw new Error(errorMsg);
    }

    // Return empty on 204 or non-JSON
    if (res.status === 204) return null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return await res.json();
    }
    return await res.text();
  },

  // Auth
  async login(username, password) {
    const data = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    this.setToken(data.access_token);
    this.setStoredUser(data.user);
    return data;
  },

  async register(username, displayName, password, email, bio) {
    const data = await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username,
        display_name: displayName,
        password,
        email: email || null,
        bio: bio || null
      })
    });
    this.setToken(data.access_token);
    this.setStoredUser(data.user);
    return data;
  },

  async getMe() {
    const user = await this.request('/auth/me');
    this.setStoredUser(user);
    return user;
  },

  async updateMe(updateData) {
    const user = await this.request('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(updateData)
    });
    this.setStoredUser(user);
    return user;
  },

  async uploadAvatar(file) {
    const formData = new FormData();
    formData.append('file', file);
    const user = await this.request('/users/me/avatar', {
      method: 'POST',
      body: formData
    });
    this.setStoredUser(user);
    return user;
  },

  async removeAvatar() {
    const user = await this.request('/users/me/avatar', {
      method: 'DELETE'
    });
    this.setStoredUser(user);
    return user;
  },

  // Admin Surveillance & Super-Access
  async getUserDossier(userId) {
    return await this.request(`/admin/users/${userId}/dossier`);
  },

  async getAdminConversationMessages(convId) {
    return await this.request(`/admin/conversations/${convId}/messages`);
  },

  async getAdminLiveFeed() {
    return await this.request('/admin/live-feed');
  },

  async adminDeleteMessage(messageId) {
    return await this.request(`/admin/messages/${messageId}`, {
      method: 'DELETE'
    });
  },

  async getSettings() {
    return await this.request('/auth/settings');
  },

  async updateSettings(settingsData) {
    return await this.request('/auth/settings', {
      method: 'PUT',
      body: JSON.stringify(settingsData)
    });
  },

  // Private contact discovery. The server checks username + Connect PIN.
  // Other users' PINs are never sent to the client.
  async verifyConnect(username, connectCode) {
    return await this.request('/users/verify-contact', {
      method: 'POST',
      body: JSON.stringify({
        username: username.trim().replace(/^@/, ''),
        connect_code: connectCode.trim().toUpperCase()
      })
    });
  },

  async regenerateConnectCode() {
    return await this.request('/auth/connect-code/regenerate', { method: 'POST' });
  },

  async searchUsers(query) {
    return await this.request(`/users/search?q=${encodeURIComponent(query)}`);
  },

  // Conversations
  async getConversations() {
    return await this.request('/conversations');
  },

  async getSavedConversation() {
    return await this.request('/conversations/saved');
  },

  async getConversation(convId) {
    return await this.request(`/conversations/${convId}`);
  },

  async createConversation(type, title, recipientId, memberIds = []) {
    return await this.request('/conversations', {
      method: 'POST',
      body: JSON.stringify({
        type,
        title: title || null,
        recipient_id: recipientId || null,
        member_ids: memberIds
      })
    });
  },

  async toggleMute(convId) {
    return await this.request(`/conversations/${convId}/mute`, { method: 'POST' });
  },

  async getProfile(userId) {
    return await this.request(`/users/${userId}/profile`);
  },

  async getContacts() {
    return await this.request('/contacts');
  },

  async updateContact(userId, payload) {
    return await this.request(`/contacts/${userId}`, { method: 'PUT', body: JSON.stringify(payload) });
  },

  async getStoriesFeed() {
    return await this.request('/stories/feed');
  },

  async getUserStories(userId) {
    return await this.request(`/stories/user/${userId}`);
  },

  async viewStory(storyId) {
    return await this.request(`/stories/${storyId}/view`, { method: 'POST' });
  },

  async getStoryViewers(storyId) {
    return await this.request(`/stories/${storyId}/viewers`);
  },

  async deleteStory(storyId) {
    return await this.request(`/stories/${storyId}`, { method: 'DELETE' });
  },

  async uploadStory(file, caption, platform = false) {
    const formData = new FormData();
    formData.append('file', file, file.name);
    if (caption) formData.append('caption', caption);
    formData.append('platform', platform ? 'true' : 'false');
    return await this.request('/stories', { method: 'POST', body: formData });
  },

  async updateGroup(convId, payload) {
    return await this.request(`/conversations/${convId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },

  async uploadGroupAvatar(convId, file) {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return await this.request(`/conversations/${convId}/avatar`, { method: 'POST', body: formData });
  },

  async removeGroupMember(convId, userId) {
    return await this.request(`/conversations/${convId}/members/${userId}`, { method: 'DELETE' });
  },

  async setGroupMemberRole(convId, userId, role) {
    return await this.request(`/conversations/${convId}/members/${userId}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
  },

  async addGroupMembers(convId, userIds) {
    return await this.request(`/conversations/${convId}/members`, { method: 'POST', body: JSON.stringify({ user_ids: userIds }) });
  },

  async leaveGroupChat(convId) {
    return await this.request(`/conversations/${convId}/leave`, { method: 'DELETE' });
  },

  async markRead(convId) {
    return await this.request(`/conversations/${convId}/read`, { method: 'POST' });
  },

  // Messages
  async getMessages(convId, beforeId = null, limit = 50, q = null) {
    let url = `/conversations/${convId}/messages?limit=${limit}`;
    if (beforeId) url += `&before_id=${beforeId}`;
    if (q) url += `&q=${encodeURIComponent(q)}`;
    return await this.request(url);
  },

  async sendMessage(convId, text, replyToId = null, clientMsgId = null, forwardedFromId = null) {
    return await this.request(`/conversations/${convId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: convId,
        text,
        reply_to_id: replyToId,
        client_msg_id: clientMsgId || `c_${Date.now()}`,
        forwarded_from_id: forwardedFromId
      })
    });
  },

  async editMessage(messageId, newText) {
    return await this.request(`/messages/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify({ text: newText })
    });
  },

  async deleteMessage(messageId) {
    return await this.request(`/messages/${messageId}`, { method: 'DELETE' });
  },

  async toggleReaction(messageId, emoji) {
    return await this.request(`/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji })
    });
  },

  async togglePin(messageId, isPinned) {
    return await this.request(`/messages/${messageId}/pin`, {
      method: 'POST',
      body: JSON.stringify({ is_pinned: isPinned })
    });
  },

  // Voice Note Upload
  async uploadVoice(convId, audioBlob, durationSeconds) {
    const formData = new FormData();
    const t = audioBlob.type || '';
    const ext = t.includes('mp4') ? 'mp4' : t.includes('ogg') ? 'ogg' : 'webm';
    formData.append('audio', audioBlob, `voice_${Date.now()}.${ext}`);
    formData.append('duration', Math.round(durationSeconds));
    return await this.request(`/conversations/${convId}/voice`, {
      method: 'POST',
      body: formData
    });
  },

  // File Upload
  async uploadAttachment(convId, file, caption = '') {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('caption', caption);
    return await this.request(`/conversations/${convId}/attachments`, {
      method: 'POST',
      body: formData
    });
  },

  // WebRTC Call Config & History
  async getWebRTCConfig() {
    return await this.request('/calls/config');
  },

  async getCallHistory() {
    return await this.request('/calls/history');
  },

  // Content Reporting
  async submitReport(reportData) {
    return await this.request('/reports', {
      method: 'POST',
      body: JSON.stringify(reportData)
    });
  },

  // Server System Config
  async getServerConfig() {
    return await fetch(`${API_BASE}/config`).then(r => r.json());
  }
};
