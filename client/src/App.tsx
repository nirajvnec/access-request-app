import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import AllRequests from './pages/AllRequests'
import CreateRequest from './pages/CreateRequest'
import PendingExpiry from './pages/PendingExpiry'
import RevokeExpired from './pages/RevokeExpired'
import ExpiryNotifications from './pages/ExpiryNotifications'
import './App.css'

function App() {
  return (
    <BrowserRouter>
      <div className="container">
        <nav className="navbar">
          <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-link active-link' : 'nav-link'}>
            All Requests
          </NavLink>
          <NavLink to="/create" className={({ isActive }) => isActive ? 'nav-link active-link' : 'nav-link'}>
            Create Request
          </NavLink>
          <NavLink to="/pending-expiry" className={({ isActive }) => isActive ? 'nav-link active-link' : 'nav-link'}>
            Pending Expiry
          </NavLink>
          <NavLink to="/notifications" className={({ isActive }) => isActive ? 'nav-link active-link' : 'nav-link'}>
            Notifications
          </NavLink>
          <NavLink to="/revoke-expired" className={({ isActive }) => isActive ? 'nav-link active-link' : 'nav-link'}>
            Revoke Expired
          </NavLink>
        </nav>

        <Routes>
          <Route path="/" element={<AllRequests />} />
          <Route path="/create" element={<CreateRequest />} />
          <Route path="/pending-expiry" element={<PendingExpiry />} />
          <Route path="/notifications" element={<ExpiryNotifications />} />
          <Route path="/revoke-expired" element={<RevokeExpired />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App
