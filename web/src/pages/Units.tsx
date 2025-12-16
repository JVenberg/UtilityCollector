import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useUnits } from '../hooks/useUnits';
import type { TrashCan } from '../types';

export function Units() {
  const { units, loading, error, addUnit, deleteUnit } = useUnits();
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    sqft: '',
    submeter_id: '',
    email: '',
  });
  const [saving, setSaving] = useState(false);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded">
        Error loading units: {error}
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await addUnit({
        name: formData.name,
        sqft: parseInt(formData.sqft) || 0,
        submeter_id: formData.submeter_id,
        email: formData.email,
        trash_cans: [],
      });
      setFormData({ name: '', sqft: '', submeter_id: '', email: '' });
      setShowForm(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete ${name}?`)) {
      await deleteUnit(id);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Units</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          {showForm ? 'Cancel' : 'Add Unit'}
        </button>
      </div>

      {/* Add Unit Form */}
      {showForm && (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">New Unit</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Unit Name
                </label>
                <input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Unit 401"
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Square Feet
                </label>
                <input
                  type="number"
                  required
                  value={formData.sqft}
                  onChange={(e) => setFormData(prev => ({ ...prev, sqft: e.target.value }))}
                  placeholder="850"
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Submeter ID
                </label>
                <input
                  type="text"
                  required
                  value={formData.submeter_id}
                  onChange={(e) => setFormData(prev => ({ ...prev, submeter_id: e.target.value }))}
                  placeholder="SM-401"
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tenant Email
                </label>
                <input
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                  placeholder="tenant@example.com"
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Creating...' : 'Create Unit'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Units List */}
      {units.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <p className="text-gray-500 mb-4">No units configured yet.</p>
          <button
            onClick={() => setShowForm(true)}
            className="text-blue-600 hover:underline"
          >
            Add your first unit
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {units.map(unit => (
            <div key={unit.id} className="bg-white rounded-lg shadow p-4">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="font-semibold text-lg">{unit.name}</h3>
                  <p className="text-sm text-gray-500">{unit.email}</p>
                </div>
                <div className="flex gap-2">
                  <Link
                    to={`/units/${unit.id}/edit`}
                    className="text-blue-600 hover:text-blue-800 text-sm"
                  >
                    Edit
                  </Link>
                  <button
                    onClick={() => handleDelete(unit.id, unit.name)}
                    className="text-red-600 hover:text-red-800 text-sm"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="space-y-1 text-sm">
                <p><span className="text-gray-500">Sqft:</span> {unit.sqft}</p>
                <p><span className="text-gray-500">Submeter:</span> {unit.submeter_id}</p>
                {unit.trash_cans && unit.trash_cans.length > 0 && (
                  <div>
                    <span className="text-gray-500">Trash Cans:</span>
                    <ul className="ml-4 list-disc list-inside">
                      {unit.trash_cans.map((can: TrashCan, idx: number) => (
                        <li key={idx}>{can.service_type} ({can.size} gal)</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
