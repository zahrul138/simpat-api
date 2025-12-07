// File: C:\ProjekMagang\simpat-api\src\middleware\dateFormatter.js
const formatScheduleDates = (req, res, next) => {
  const originalJson = res.json;
  
  res.json = function(data) {
    try {
      // Log untuk debugging
      console.log('[DateFormatter] Processing response for path:', req.path);
      
      // Jika data memiliki items (array schedules)
      if (data && data.items && Array.isArray(data.items)) {
        data.items = data.items.map(schedule => {
          if (schedule.target_date) {
            try {
              console.log('[DateFormatter] Original target_date:', schedule.target_date);
              
              // Coba parse tanggal dalam berbagai format
              let dateObj;
              if (schedule.target_date.includes('T')) {
                // ISO format dengan timezone
                dateObj = new Date(schedule.target_date);
              } else {
                // String format YYYY-MM-DD
                dateObj = new Date(schedule.target_date + 'T00:00:00');
              }
              
              // Validasi date
              if (!isNaN(dateObj.getTime())) {
                // Format ke YYYY-MM-DD untuk frontend
                const year = dateObj.getFullYear();
                const month = String(dateObj.getMonth() + 1).padStart(2, '0');
                const day = String(dateObj.getDate()).padStart(2, '0');
                schedule.target_date_display = `${year}-${month}-${day}`;
                
                console.log('[DateFormatter] Formatted target_date_display:', schedule.target_date_display);
              } else {
                console.warn('[DateFormatter] Invalid date:', schedule.target_date);
                schedule.target_date_display = schedule.target_date;
              }
            } catch (err) {
              console.error('[DateFormatter] Error formatting date:', err.message);
              schedule.target_date_display = schedule.target_date;
            }
          }
          return schedule;
        });
      }
      
      // Jika data single schedule (GET /:id)
      else if (data && data.header && data.header.target_date) {
        try {
          console.log('[DateFormatter] Single schedule header.target_date:', data.header.target_date);
          
          let dateObj;
          if (data.header.target_date.includes('T')) {
            dateObj = new Date(data.header.target_date);
          } else {
            dateObj = new Date(data.header.target_date + 'T00:00:00');
          }
          
          if (!isNaN(dateObj.getTime())) {
            const year = dateObj.getFullYear();
            const month = String(dateObj.getMonth() + 1).padStart(2, '0');
            const day = String(dateObj.getDate()).padStart(2, '0');
            data.header.target_date_display = `${year}-${month}-${day}`;
            
            console.log('[DateFormatter] Single schedule formatted:', data.header.target_date_display);
          } else {
            data.header.target_date_display = data.header.target_date;
          }
        } catch (err) {
          console.error('[DateFormatter] Error formatting single schedule:', err.message);
          data.header.target_date_display = data.header.target_date;
        }
      }
      
      // Jika response adalah schedule langsung tanpa header wrapper
      else if (data && data.target_date) {
        try {
          console.log('[DateFormatter] Direct schedule target_date:', data.target_date);
          
          let dateObj;
          if (data.target_date.includes('T')) {
            dateObj = new Date(data.target_date);
          } else {
            dateObj = new Date(data.target_date + 'T00:00:00');
          }
          
          if (!isNaN(dateObj.getTime())) {
            const year = dateObj.getFullYear();
            const month = String(dateObj.getMonth() + 1).padStart(2, '0');
            const day = String(dateObj.getDate()).padStart(2, '0');
            data.target_date_display = `${year}-${month}-${day}`;
            
            console.log('[DateFormatter] Direct schedule formatted:', data.target_date_display);
          } else {
            data.target_date_display = data.target_date;
          }
        } catch (err) {
          console.error('[DateFormatter] Error formatting direct schedule:', err.message);
          data.target_date_display = data.target_date;
        }
      }
    } catch (err) {
      console.error('[DateFormatter] Unexpected error:', err.message);
      // Jangan ganggu response jika ada error
    }
    
    return originalJson.call(this, data);
  };
  
  next();
};

module.exports = formatScheduleDates;