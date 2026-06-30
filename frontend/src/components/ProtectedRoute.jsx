import { Navigate } from 'react-router-dom'
import { authService } from '../services/authService'

const ProtectedRoute = ({ children, role }) => {
  if (!authService.isAuthenticated()) {
    return <Navigate to="/login" replace />
  }
  // Optional role gate (e.g. role="org_admin" for the admin console).
  if (role && authService.getUser()?.role !== role) {
    return <Navigate to="/dashboard" replace />
  }
  return children
}

export default ProtectedRoute
