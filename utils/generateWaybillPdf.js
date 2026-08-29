const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { UPLOAD_ROOT } = require("./upload");

/**
 * generateWaybillPdf — builds a downloadable way bill PDF for an OUTGOING
 * vehicle trip (one we're sending) and saves it to
 * uploads/waybills-generated/<waybill_number>.pdf. Returns the absolute path.
 */
const generateWaybillPdf = ({ trip, company }) => {
  return new Promise((resolve, reject) => {
    try {
      const fileName = `${trip.waybill_number}.pdf`;
      const outPath = path.join(UPLOAD_ROOT, "waybills-generated", fileName);
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);

      if (company.logo_path) {
        const absLogoPath = path.join(UPLOAD_ROOT, "..", company.logo_path.replace(/^\/uploads/, "uploads"));
        if (fs.existsSync(absLogoPath)) {
          try {
            doc.image(absLogoPath, 50, 45, { width: 90 });
          } catch (_) {
            /* skip a corrupt/unsupported logo silently */
          }
        }
      }

      doc
        .fontSize(18)
        .text(company.company_name || "FIRST TRACK KHATANEX", 160, 50, { align: "right" })
        .fontSize(9)
        .fillColor("#555")
        .text(company.address || "", 160, 72, { align: "right" })
        .fillColor("#000");

      doc.moveTo(50, 120).lineTo(545, 120).strokeColor("#ccc").stroke();

      doc.fontSize(16).text("WAY BILL", 50, 135);
      doc
        .fontSize(10)
        .text(`Way Bill No: ${trip.waybill_number}`, 50, 160)
        .text(`Date: ${new Date().toLocaleString("en-IN")}`, 50, 175);

      const rows = [
        ["Vehicle Number", trip.vehicle_number],
        ["Driver Name", trip.driver_name],
        ["Driver Phone", trip.driver_phone],
        ["From", trip.from_location || "-"],
        ["To", trip.to_location || "-"],
        ["Goods Description", trip.goods_description || "-"],
      ];

      let y = 210;
      rows.forEach(([label, value]) => {
        doc.fontSize(10).fillColor("#555").text(label, 50, y).fillColor("#000").text(String(value), 220, y);
        y += 22;
      });

      doc
        .fontSize(8)
        .fillColor("#888")
        .text("This is a system-generated way bill.", 50, 780, { align: "center", width: 495 });

      doc.end();

      stream.on("finish", () => resolve(outPath));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = { generateWaybillPdf };
