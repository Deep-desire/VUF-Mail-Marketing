const Handlebars = require('handlebars');

function renderTemplate(template, variables) {
  const subjectTemplate = Handlebars.compile(template.subject);
  const htmlTemplate = Handlebars.compile(template.htmlBody);
  const plainTemplate = Handlebars.compile(template.plainTextBody);

  return {
    subject: subjectTemplate(variables),
    html: htmlTemplate(variables),
    text: plainTemplate(variables),
  };
}

module.exports = { renderTemplate };
