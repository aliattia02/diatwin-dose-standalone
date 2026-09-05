import API_BASE_URL from '../config';
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './Charts/dashboard-components.css';

const DoctorManagement = () => {
  const [availableDoctors, setAvailableDoctors] = useState([]);
  const [authorizedDoctors, setAuthorizedDoctors] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const fetchDoctors = useCallback(async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      
      // Fetch available doctors and authorized doctors in parallel
      const [availableResponse, authorizedResponse] = await Promise.all([
        axios.get(`${API_BASE_URL}/api/doctors`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        axios.get(`${API_BASE_URL}/api/patient/authorized-doctors`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ]);

      setAvailableDoctors(availableResponse.data);
      setAuthorizedDoctors(authorizedResponse.data);
      setError('');
    } catch (err) {
      console.error('Error fetching doctors:', err);
      setError('Failed to load doctors. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDoctors();
  }, [fetchDoctors]);

  const authorizeDoctor = async (doctorId) => {
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `${API_BASE_URL}/api/patient/authorize-doctor`,
        { doctor_id: doctorId },
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      
      setMessage('Doctor authorized successfully!');
      setTimeout(() => setMessage(''), 3000);
      fetchDoctors(); // Refresh the lists
    } catch (err) {
      console.error('Error authorizing doctor:', err);
      setError('Failed to authorize doctor. Please try again.');
      setTimeout(() => setError(''), 3000);
    }
  };

  const revokeDoctor = async (doctorId) => {
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `${API_BASE_URL}/api/patient/revoke-doctor`,
        { doctor_id: doctorId },
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      
      setMessage('Doctor access revoked successfully!');
      setTimeout(() => setMessage(''), 3000);
      fetchDoctors(); // Refresh the lists
    } catch (err) {
      console.error('Error revoking doctor:', err);
      setError('Failed to revoke doctor access.  Please try again.');
      setTimeout(() => setError(''), 3000);
    }
  };

  const authorizedDoctorIds = authorizedDoctors.map(d => d.id);
  
  const filteredAvailableDoctors = availableDoctors.filter(doctor => 
    ! authorizedDoctorIds.includes(doctor.id) &&
    (`${doctor.firstName} ${doctor.lastName}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
     doctor.email.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  if (loading) {
    return <div className="dash-doctor-loading">Loading doctors...</div>;
  }

  return (
    <div className="dash-doctor-management">
      <h3>Manage Your Doctors</h3>
      <p className="dash-doctor-description">
        Select which doctors can view your health data.  Only doctors you authorize will have access to your information.
      </p>

      {error && <div className="dash-doctor-error-banner">{error}</div>}
      {message && <div className="dash-doctor-success-banner">{message}</div>}

      {/* Authorized Doctors Section */}
      <div className="dash-authorized-doctors-section">
        <h4>Your Authorized Doctors ({authorizedDoctors.length})</h4>
        {authorizedDoctors.length === 0 ? (
          <p className="dash-no-doctors">You haven't authorized any doctors yet.  Search and add doctors below. </p>
        ) : (
          <div className="dash-doctors-list">
            {authorizedDoctors.map(doctor => (
              <div key={doctor.id} className="dash-doctor-card dash-authorized">
                <div className="dash-doctor-info">
                  <span className="dash-doctor-name">
                    Dr. {doctor.firstName} {doctor.lastName}
                  </span>
                  <span className="dash-doctor-email">{doctor.email}</span>
                </div>
                <button
                  onClick={() => revokeDoctor(doctor.id)}
                  className="dash-revoke-button"
                  title="Revoke access"
                >
                  Revoke Access
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Available Doctors Section */}
      <div className="dash-available-doctors-section">
        <h4>Add New Doctor</h4>
        <input
          type="text"
          placeholder="Search doctors by name or email..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="dash-doctor-search-input"
        />
        
        {filteredAvailableDoctors.length === 0 ? (
          <p className="dash-no-doctors">
            {searchTerm ? 'No doctors found matching your search.' : 'All available doctors have been authorized.'}
          </p>
        ) : (
          <div className="dash-doctors-list">
            {filteredAvailableDoctors.map(doctor => (
              <div key={doctor.id} className="dash-doctor-card">
                <div className="dash-doctor-info">
                  <span className="dash-doctor-name">
                    Dr. {doctor.firstName} {doctor.lastName}
                  </span>
                  <span className="dash-doctor-email">{doctor.email}</span>
                </div>
                <button
                  onClick={() => authorizeDoctor(doctor.id)}
                  className="dash-authorize-button"
                  title="Authorize this doctor"
                >
                  Authorize
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DoctorManagement;




