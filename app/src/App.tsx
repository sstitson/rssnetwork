import { Routes, Route } from 'react-router-dom'
import { CustomAuthProvider, AuthCallback, Login, AuthExpiredHandler } from './auth'
import { RssFeeds } from './components/RssFeeds'
import { ManageFeeds } from './components/ManageFeeds'
import { AdminPage } from './components/AdminPage'
import { Logout } from './components/Logout'
import { UserPage } from './components/UserPage'
import { ChatPage } from './components/ChatPage'
import { StoryPage } from './components/StoryPage'
import { TopNav } from './components/TopNav'
import { AlertsHost } from './components/AlertsHost'
import './App.css'

/**
 * Main Application Component
 *
 * Routes:
 *   /            RSS reader (feeds left column, stories right)
 *   /user        Account details
 *   /login, /auth/callback, /auth/logout   Public auth routes
 *
 * Authentication (Cognito hosted UI + OIDC):
 * 1. App loads; CustomAuthProvider checks for a valid session
 * 2. If unauthenticated it navigates to /login
 * 3. "Sign in" redirects to the Cognito hosted UI
 * 4. Cognito redirects back to /auth/callback, which exchanges the code
 * 5. The ID token is exchanged at the Identity Pool for temporary AWS
 *    credentials, which the app uses to read S3 and invoke the RSS daemon
 */
function App() {
  return (
    <>
      <AlertsHost />
      <Routes>
        {/* Public routes — no authentication required */}
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/auth/logout" element={<Logout />} />

        {/* Protected routes — single auth provider for all */}
        <Route path="/*" element={
          <CustomAuthProvider>
            <AuthExpiredHandler />
            <TopNav />
            <Routes>
              <Route path="/user" element={<UserPage />} />
              <Route path="/chat" element={<ChatPage />} />
              {/* One story, linked to from briefing footnotes. */}
              <Route path="/story/:storyKey" element={<StoryPage />} />
              {/* Wildcard: the section has sub-pages (/feeds/manage/opml). */}
              <Route path="/feeds/manage/*" element={<ManageFeeds />} />
              {/* AdminPage self-checks the admin account and refuses otherwise. */}
              {/* Wildcard: the section has sub-pages (/admin/curated). */}
              <Route path="/admin/*" element={<AdminPage />} />
              {/* The reader IS the app: feeds left, stories right, at root. */}
              <Route path="*" element={<RssFeeds />} />
            </Routes>
          </CustomAuthProvider>
        } />
      </Routes>
    </>
  )
}

export default App
